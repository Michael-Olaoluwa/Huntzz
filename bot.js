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
    kb.text(`${subSet.has(g.chat_id) ? "✅" : "➕"} ${g.title}`, `sub:${g.chat_id}`).row();
  }
  return {
    text: "My groups — tap a group to subscribe or unsubscribe:\n\n" + lines.join("\n"),
    markup: kb,
  };
};

// --- Keywords views ---
const keywordsMenuView = async (userId) => {
  const { data: subs } = check(
    "listSubs",
    await supabase
      .from("subscriptions")
      .select("chat_id, groups(title, active)")
      .eq("user_id", userId)
  );
  const active = (subs ?? []).filter((s) => s.groups?.active);

  if (!active.length) {
    return {
      text: "You're not subscribed to any group yet. Open My groups and subscribe first.",
      markup: new InlineKeyboard().text("👥 My groups", "my_groups"),
    };
  }

  const kb = new InlineKeyboard();
  for (const s of active) kb.text(`🔑 ${s.groups.title}`, `kw:${s.chat_id}`).row();
  return {
    text: "Keywords — choose a group to manage its keywords:",
    markup: kb,
  };
};

const keywordsView = async (userId, chatId) => {
  const { data: sub } = check(
    "findSub",
    await supabase
      .from("subscriptions")
      .select("chat_id, groups(title)")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .maybeSingle()
  );
  if (!sub) {
    return {
      text: "You're not subscribed to that group anymore.",
      markup: new InlineKeyboard().text("⬅️ Back", "keywords_menu"),
    };
  }

  const { data: kws } = check(
    "listKeywords",
    await supabase
      .from("keywords")
      .select("id, keyword")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .order("keyword")
  );

  const kb = new InlineKeyboard();
  for (const k of kws ?? []) kb.text(`🗑 ${k.keyword}`, `delkw:${chatId}:${k.id}`).row();
  kb.text("➕ Add keyword", `addkw:${chatId}`).row();
  kb.text("⬅️ Back", "keywords_menu");

  return {
    text:
      `Keywords for "${sub.groups.title}" — tap a keyword to remove it.\n` +
      `You'll get a DM when a message in this group contains one of them.\n\n` +
      (kws?.length ? kws.map((k) => `• ${k.keyword}`).join("\n") : "No keywords yet."),
    markup: kb,
  };
};

// --- keyword input in progress: userId -> chatId ---
const pending = new Map();

// --- matching + delivery ---
const matchAndDeliver = async (chat, text, senderId, senderName) => {
  const [kwRes, subRes] = await Promise.all([
    supabase.from("keywords").select("user_id, keyword").eq("chat_id", chat.id),
    supabase.from("subscriptions").select("user_id").eq("chat_id", chat.id),
  ]);
  if (kwRes.error) return console.error("[supabase:matchKeywords]", kwRes.error.message);
  if (subRes.error) return console.error("[supabase:matchSubs]", subRes.error.message);

  const subbed = new Set(subRes.data.map((s) => s.user_id));
  const lower = text.toLowerCase();
  const hits = new Map();

  for (const { user_id, keyword } of kwRes.data) {
    if (user_id === senderId) continue;
    if (!subbed.has(user_id)) continue;
    if (lower.includes(keyword.toLowerCase())) {
      if (!hits.has(user_id)) hits.set(user_id, []);
      hits.get(user_id).push(keyword);
    }
  }

  const preview = text.length > 400 ? text.slice(0, 400) + "…" : text;
  for (const [userId, words] of hits) {
    bot.api
      .sendMessage(
        userId,
        `🔔 Match in "${chat.title}"\n${senderName}: ${preview}\n\nKeyword: ${words.join(", ")}`
      )
      .catch((err) => console.error(`DM to ${userId} failed: ${err.description}`));
  }
};

// --- /start: private chat menu ---
bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  const me = await bot.api.getMe();
  const kb = new InlineKeyboard()
    .url("➕ Add me to a group", `https://t.me/${me.username}?startgroup=true`)
    .row()
    .text("👥 My groups", "my_groups")
    .row()
    .text("🔑 Keywords", "keywords_menu");
  await ctx.reply(
    "Hi! I help you catch the messages that matter in your Telegram groups.\n\nAdd me to a group to get started.",
    { reply_markup: kb }
  );
});

// --- keywords menu (command + back button) ---
const showKeywordsMenu = async (ctx, edit) => {
  const view = await keywordsMenuView(ctx.from.id);
  if (edit) {
    await ctx.editMessageText(view.text, { reply_markup: view.markup }).catch(async () => {
      await ctx.reply(view.text, { reply_markup: view.markup });
    });
  } else {
    await ctx.reply(view.text, { reply_markup: view.markup });
  }
};

bot.command("keywords", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await showKeywordsMenu(ctx, false);
});

bot.callbackQuery("keywords_menu", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await showKeywordsMenu(ctx, true);
});

bot.callbackQuery(/^kw:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery().catch(() => {});
  const view = await keywordsView(ctx.from.id, chatId);
  await ctx.editMessageText(view.text, { reply_markup: view.markup }).catch(async () => {
    await ctx.reply(view.text, { reply_markup: view.markup });
  });
});

bot.callbackQuery(/^addkw:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const { data: sub } = check(
    "findSub",
    await supabase
      .from("subscriptions")
      .select("chat_id")
      .eq("user_id", ctx.from.id)
      .eq("chat_id", chatId)
      .maybeSingle()
  );
  if (!sub) {
    await ctx.answerCallbackQuery({ text: "You're not subscribed to that group." }).catch(() => {});
    return;
  }
  pending.set(ctx.from.id, chatId);
  await ctx.answerCallbackQuery({ text: "Send me the keyword now." }).catch(() => {});
  await ctx
    .reply('Send me the keyword to watch for in this group (e.g. "job"). Send /cancel to stop.')
    .catch(() => {});
});

bot.command("cancel", async (ctx) => {
  if (pending.delete(ctx.from.id)) {
    await ctx.reply("Cancelled — no keyword added.").catch(() => {});
  }
});

bot.callbackQuery(/^delkw:(-?\d+):(\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const id = Number(ctx.match[2]);
  check("deleteKeyword", await supabase.from("keywords").delete().eq("id", id).eq("user_id", ctx.from.id));
  await ctx.answerCallbackQuery({ text: "Removed." }).catch(() => {});
  const view = await keywordsView(ctx.from.id, chatId);
  await ctx.editMessageText(view.text, { reply_markup: view.markup }).catch(() => {});
});

// --- /start: My groups ---
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

  const view = await groupsView(ctx.from.id);
  await ctx.editMessageText(view.text, { reply_markup: view.markup }).catch(() => {});
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

// --- messages: keyword input, logging, matching ---
bot.on("message", async (ctx) => {
  const chat = ctx.chat;

  if (chat.type === "private") {
    const target = pending.get(ctx.from.id);
    if (target && ctx.message.text && !ctx.message.text.startsWith("/")) {
      const keyword = ctx.message.text.trim().toLowerCase();
      pending.delete(ctx.from.id);
      if (!keyword) {
        await ctx.reply("That keyword is empty. Send another one or /cancel.");
        return;
      }
      const { error } = await supabase
        .from("keywords")
        .upsert(
          { user_id: ctx.from.id, chat_id: target, keyword },
          { onConflict: "user_id,chat_id,keyword" }
        );
      if (error) console.error("[supabase:addKeyword]", error.message);
      await ctx
        .reply(error ? `Couldn't save the keyword: ${error.message}` : `✅ Watching for "${keyword}".`)
        .catch(() => {});
      const view = await keywordsView(ctx.from.id, target);
      await ctx.reply(view.text, { reply_markup: view.markup }).catch(() => {});
    }
    return;
  }

  if (chat.type === "group" || chat.type === "supergroup") {
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    console.log(`[${chat.title}] ${ctx.from?.first_name}: ${text}`);
    if (text) await matchAndDeliver(chat, text, ctx.from?.id, ctx.from?.first_name ?? "?");
  }
});

bot.on("channel_post", async (ctx) => {
  const text = ctx.channelPost.text ?? ctx.channelPost.caption ?? "";
  console.log(`[CHANNEL ${ctx.chat.title}] ${text}`);
  if (text) {
    const sender = ctx.senderChat?.title ?? ctx.from?.first_name ?? "channel";
    await matchAndDeliver(ctx.chat, text, ctx.from?.id, sender);
  }
});

bot.start({
  allowed_updates: ["message", "channel_post", "my_chat_member", "callback_query"],
});
