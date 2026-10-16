import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { createClient } from "@supabase/supabase-js";

if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Add it to your .env file.");
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_KEY missing. Add them to your .env file.");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Bot(process.env.BOT_TOKEN);

const check = (op, res) => {
  if (res.error) console.error(`[supabase:${op}]`, res.error.message);
  return res;
};

const upsertUser = async (user) => {
  check(
    "upsertUser",
    await supabase
      .from("users")
      .upsert(
        { user_id: user.id, username: user.username ?? null, first_name: user.first_name ?? null },
        { onConflict: "user_id" }
      )
  );
};

// --- My groups view ---
const groupsView = async (userId) => {
  const { data: groups } = check(
    "listGroups",
    await supabase.from("groups").select("chat_id,title").eq("active", true)
  );
  const { data: subs } = check(
    "listSubs",
    await supabase.from("subscriptions").select("chat_id").eq("user_id", userId)
  );

  if (!groups?.length) {
    const me = await bot.api.getMe();
    return {
      text: "I'm not registered in any group yet. Add me to one to get started.",
      markup: new InlineKeyboard().url(
        "➕ Add me to a group",
        `https://t.me/${me.username}?startgroup=true`
      ),
    };
  }

  const subSet = new Set((subs ?? []).map((s) => s.chat_id));
  const lines = groups.map((g) => `${subSet.has(g.chat_id) ? "✅" : "▫️"} ${g.title}`);
  const kb = new InlineKeyboard();
  for (const g of groups) {
    kb.text(
      `${subSet.has(g.chat_id) ? "✅" : "➕"} ${g.title}`,
      `sub:${g.chat_id}`
    ).row();
  }
  return {
    text:
      "My groups — tap a group to subscribe or unsubscribe:\n\n" + lines.join("\n"),
    markup: kb,
  };
};

const refreshGroupsList = async (ctx) => {
  const view = await groupsView(ctx.from.id);
  await ctx.editMessageText(view.text, { reply_markup: view.markup }).catch(() => {});
};

// --- /start: private chat menu ---
bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  const me = await bot.api.getMe();
  const kb = new InlineKeyboard()
    .url("➕ Add me to a group", `https://t.me/${me.username}?startgroup=true`)
    .row()
    .text("👥 My groups", "my_groups");
  await ctx.reply(
    "Hi! I help you catch the messages that matter in your Telegram groups.\n\nAdd me to a group to get started.",
    { reply_markup: kb }
  );
});

bot.callbackQuery("my_groups", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const view = await groupsView(ctx.from.id);
  await ctx.editMessageText(view.text, { reply_markup: view.markup }).catch(async () => {
    await ctx.reply(view.text, { reply_markup: view.markup });
  });
});

// --- subscribe / unsubscribe with membership check ---
bot.callbackQuery(/^sub:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);

  let member;
  try {
    member = await bot.api.getChatMember(chatId, ctx.from.id);
  } catch {
    await ctx
      .answerCallbackQuery({ text: "I couldn't verify your membership in that group." })
      .catch(() => {});
    return;
  }

  if (member.status === "left" || member.status === "kicked") {
    await ctx
      .answerCallbackQuery({ text: "You're not a member of that group anymore." })
      .catch(() => {});
    return;
  }

  const { data: sub } = check(
    "findSub",
    await supabase
      .from("subscriptions")
      .select("id")
      .eq("user_id", ctx.from.id)
      .eq("chat_id", chatId)
      .maybeSingle()
  );

  if (sub) {
    check("removeSub", await supabase.from("subscriptions").delete().eq("id", sub.id));
    await ctx.answerCallbackQuery({ text: "Unsubscribed." }).catch(() => {});
  } else {
    await upsertUser(ctx.from);
    const { error } = await supabase
      .from("subscriptions")
      .upsert({ user_id: ctx.from.id, chat_id: chatId }, { onConflict: "user_id,chat_id" });
    if (error) {
      console.error("[supabase:addSub]", error.message);
      await ctx
        .answerCallbackQuery({ text: "Couldn't save the subscription." })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery({ text: "Subscribed ✅" }).catch(() => {});
  }

  await refreshGroupsList(ctx);
});

// --- bot added to / removed from a group or channel ---
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  if (chat.type === "private") return;

  const status = ctx.myChatMember.new_chat_member.status;
  const adder = ctx.myChatMember.from;

  if (status === "member" || status === "administrator") {
    await upsertUser(adder);
    const { data: existing, error } = await supabase
      .from("groups")
      .select("chat_id")
      .eq("chat_id", chat.id)
      .maybeSingle();
    if (error) console.error("[supabase:findGroup]", error.message);

    if (existing) {
      check("activateGroup", await supabase.from("groups").update({ active: true }).eq("chat_id", chat.id));
      await bot.api
        .sendMessage(
          adder.id,
          `"${chat.title}" is already registered. Open me here and subscribe to it from My groups.`
        )
        .catch(() => {});
    } else {
      check(
        "insertGroup",
        await supabase.from("groups").upsert({
          chat_id: chat.id,
          title: chat.title,
          type: chat.type,
          added_by: adder.id,
          active: true,
        })
      );
      await bot.api
        .sendMessage(adder.id, `✅ "${chat.title}" is now registered.`)
        .catch(() => {});
    }
  }

  if (status === "left" || status === "kicked") {
    check("deactivateGroup", await supabase.from("groups").update({ active: false }).eq("chat_id", chat.id));
  }
});

// --- log group messages ---
bot.on("message", (ctx) => {
  const chat = ctx.chat;
  if (chat.type === "group" || chat.type === "supergroup") {
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    console.log(`[${chat.title}] ${ctx.from?.first_name}: ${text}`);
  }
});

bot.on("channel_post", (ctx) => {
  const text = ctx.channelPost.text ?? ctx.channelPost.caption ?? "";
  console.log(`[CHANNEL ${ctx.chat.title}] ${text}`);
});

bot.start({
  allowed_updates: ["message", "channel_post", "my_chat_member", "callback_query"],
});
