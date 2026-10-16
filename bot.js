import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { createClient } from "@supabase/supabase-js";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";

if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Add it to your .env file.");
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_KEY missing. Add them to your .env file.");
  process.exit(1);
}

// --- runtime config (Stage 4; logging gates are finalized in Stage 6) ---
const DEBUG = process.env.DEBUG === "true";
const AD_FILTER_MODE = ["off", "log", "drop"].includes(
  (process.env.AD_FILTER_MODE ?? "").toLowerCase()
)
  ? process.env.AD_FILTER_MODE.toLowerCase()
  : "log";

// --- limits + timers (Stage 6) ---
const MAX_KEYWORDS_PER_GROUP = 20;
const MAX_SUBSCRIPTIONS = 50;
const PENDING_TTL_MS = 10 * 60 * 1000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Bot(process.env.BOT_TOKEN);

// Rate-limit protection (Stage 6): retry 429s and space out bulk sends.
bot.api.config.use(autoRetry());
bot.api.config.use(apiThrottler());

const check = (op, res) => {
  if (res.error) console.error(`[supabase:${op}]`, res.error.message);
  return res;
};

const upsertUser = async (user) => {
  const { data: existing } = check(
    "findUser",
    await supabase.from("users").select("user_id").eq("user_id", user.id).maybeSingle()
  );
  check(
    "upsertUser",
    await supabase
      .from("users")
      .upsert(
        {
          user_id: user.id,
          username: user.username ?? null,
          first_name: user.first_name ?? null,
          blocked: false, // messaging the bot unblocks it (Stage 6)
        },
        { onConflict: "user_id" }
      )
  );
  return !existing; // true the first time we see this user (Stage 5 onboarding)
};

// --- keyword normalization + whole-word matching (Stage 2) ---
const MAX_KEYWORD_LENGTH = 40;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeKeyword = (raw) => raw.trim().replace(/\s+/g, " ").toLowerCase();

// Trim/lowercase/collapse whitespace, then cap at 40 characters.
const cleanKeyword = (raw) => {
  const normalized = normalizeKeyword(raw);
  return {
    keyword: normalized.slice(0, MAX_KEYWORD_LENGTH),
    truncated: normalized.length > MAX_KEYWORD_LENGTH,
  };
};

// A keyword must contain at least one letter or number (rejects empty/punctuation-only).
const keywordError = (keyword) => {
  if (!keyword) return "That looks empty — send a word or phrase to watch for.";
  if (!WORD_CHAR.test(keyword))
    return "A keyword needs at least one letter or number (punctuation alone won't work).";
  return null;
};

// Compiled regexes keyed by keyword. Whole-word/phrase: no letter or digit
// immediately before or after, case-insensitive, Unicode-aware. Spaces in a
// phrase match any run of whitespace, so "class cancelled" survives stray spaces.
const keywordRegexCache = new Map();
const keywordRegex = (keyword) => {
  let re = keywordRegexCache.get(keyword);
  if (!re) {
    const pattern = escapeRegex(keyword).replace(/\s+/g, "\\s+");
    re = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu");
    keywordRegexCache.set(keyword, re);
  }
  return re;
};

// --- per-chat matcher cache (Stage 2) ---
// One RPC loads every (subscriber, keyword) pair for a chat; cached briefly so a
// busy group cannot hammer Supabase. Invalidated on any subscription/keyword change.
const CHAT_CACHE_TTL_MS = 45 * 1000;
const chatCache = new Map(); // chatId -> { expires, byUser: Map<userId, string[]> }

const invalidateChatCache = (chatId) => chatCache.delete(chatId);

const getChatMatchers = async (chatId) => {
  const cached = chatCache.get(chatId);
  if (cached && cached.expires > Date.now()) return cached.byUser;

  const { data, error } = await supabase.rpc("chat_matchers", { p_chat_id: chatId });
  if (error) {
    console.error("[supabase:chatMatchers]", error.message);
    return new Map();
  }
  const byUser = new Map();
  for (const row of data ?? []) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row.keyword);
  }
  chatCache.set(chatId, { expires: Date.now() + CHAT_CACHE_TTL_MS, byUser });
  return byUser;
};

// --- My groups view ---
const groupsView = async (userId) => {
  const { data: groups } = check(
    "listGroups",
    await supabase.from("groups").select("chat_id,title").eq("active", true)
  );
  const { data: subs } = check(
    "listSubs",
    await supabase.from("subscriptions").select("chat_id").eq("user_id", userId).eq("active", true)
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
      .eq("active", true)
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
      .eq("active", true)
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

// --- pending input (Stage 6): persisted in pending_input, 10-minute TTL ---
const PENDING_ACTION_ADD_KEYWORD = "add_keyword";

const setPending = async (userId, action, chatId) => {
  check(
    "setPending",
    await supabase
      .from("pending_input")
      .upsert(
        { user_id: userId, action, chat_id: chatId, created_at: new Date().toISOString() },
        { onConflict: "user_id" }
      )
  );
};

const clearPending = async (userId) => {
  check("clearPending", await supabase.from("pending_input").delete().eq("user_id", userId));
};

// Returns the live pending row, or null when absent/expired (expired rows deleted).
const getPending = async (userId) => {
  const { data, error } = await supabase
    .from("pending_input")
    .select("action, chat_id, created_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[supabase:getPending]", error.message);
    return null;
  }
  if (!data) return null;
  if (Date.now() - new Date(data.created_at).getTime() > PENDING_TTL_MS) {
    await clearPending(userId);
    return null;
  }
  return data;
};

// Any command clears a user's pending input (Stage 6).
bot.use(async (ctx, next) => {
  if (ctx.chat?.type === "private" && ctx.from && ctx.message?.text?.startsWith("/")) {
    await clearPending(ctx.from.id);
  }
  return next();
});

// ===== Ad filter patterns (Stage 4) — tune me =====
const AD_PATTERNS = [
  /t\.me\/\+/i, // t.me/+ invite links
  /t\.me\/joinchat/i, // legacy invite links
  /join (our|my|the) (channel|group)/i,
  /subscribe (to|now)/i,
  /click (the )?link/i,
];
// ==================================================

const looksLikeAd = (text) => AD_PATTERNS.some((re) => re.test(text));

// Admin ids per chat, cached for 10 minutes (used to exempt admins in drop mode).
const ADMIN_CACHE_TTL_MS = 10 * 60 * 1000;
const adminCache = new Map(); // chatId -> { expires, ids: Set<userId> }

const getChatAdminIds = async (chatId) => {
  const cached = adminCache.get(chatId);
  if (cached && cached.expires > Date.now()) return cached.ids;
  try {
    const admins = await bot.api.getChatAdministrators(chatId);
    const ids = new Set(admins.map((m) => m.user.id));
    adminCache.set(chatId, { expires: Date.now() + ADMIN_CACHE_TTL_MS, ids });
    return ids;
  } catch (err) {
    console.error(`[adminCache] getChatAdministrators(${chatId}) failed: ${err.description}`);
    return new Set(); // fail safe: unknown sender is treated as non-admin
  }
};

// Decide whether a suspected ad should be dropped. Only "drop" mode filters, and
// admins are exempt (channel posts always count as admin).
const shouldDropForAd = async (chat, text, senderId) => {
  if (AD_FILTER_MODE === "off" || !looksLikeAd(text)) return false;

  if (AD_FILTER_MODE === "log") {
    if (DEBUG) console.log(`[adFilter] looks like an ad in chat ${chat.id} (not dropping)`);
    return false;
  }

  if (chat.type === "channel") return false; // channel posts always come from an admin

  const adminIds = await getChatAdminIds(chat.id);
  if (senderId !== undefined && adminIds.has(senderId)) return false;

  if (DEBUG) console.log(`[adFilter] dropping alert for suspected ad in chat ${chat.id}`);
  return true;
};

// --- matching + delivery ---
// Escape user-derived text so an alert can never break or inject HTML.
const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Deep link to the original message. The t.me/c/<id> form only opens for members
// of that chat; it works for supergroups and channels, not plain groups.
const messageLink = (chat, messageId) => {
  if (!messageId) return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  if (chat.type === "supergroup" || chat.type === "channel") {
    const id = String(chat.id).replace(/^-100/, "");
    return `https://t.me/c/${id}/${messageId}`;
  }
  return null;
};

const matchAndDeliver = async (chat, text, { senderId, senderName, messageId }) => {
  const byUser = await getChatMatchers(chat.id);
  const hits = new Map();

  for (const [userId, keywords] of byUser) {
    if (userId === senderId) continue; // never alert a user about their own message
    const matched = keywords.filter((keyword) => keywordRegex(keyword).test(text));
    if (matched.length) hits.set(userId, matched); // one alert per user, listing all keywords
  }

  const preview = escapeHtml(text.length > 300 ? text.slice(0, 300) + "…" : text);
  const link = messageLink(chat, messageId);

  for (const [userId, words] of hits) {
    const lines = [`🔔 <b>${escapeHtml(chat.title)}</b>`];
    if (senderName) lines.push(`${escapeHtml(senderName)}: ${preview}`);
    else lines.push(preview);
    lines.push(`\nKeyword: ${escapeHtml(words.join(", "))}`);
    if (link) lines.push(`<a href="${link}">Open message</a>`);

    // Sequential fan-out so a burst of matches cannot trip Telegram rate limits.
    try {
      await bot.api.sendMessage(userId, lines.join("\n"), { parse_mode: "HTML" });
    } catch (err) {
      if (err?.error_code === 403) {
        // User blocked the bot (or deactivated): pause their alerts.
        check("blockUser", await supabase.from("users").update({ blocked: true }).eq("user_id", userId));
        console.error(`[alerts] user ${userId} blocked the bot; alerts paused`);
      } else {
        // Log the error only — never the message text.
        console.error(`[alerts] DM to ${userId} failed: ${err?.description ?? err?.message}`);
      }
    }
  }
};

// --- onboarding text (Stage 5) ---
const HELP_TEXT = [
  "Huntzz alerts you when a message you care about is posted in a group or channel you follow.",
  "",
  "<b>How it works</b>",
  "• Add me to a group or channel.",
  "• Subscribe to it from “My groups”.",
  "• Add keywords for it from “Keywords”.",
  "• I DM you when a message matches.",
  "",
  "<b>Commands</b>",
  "/start — main menu",
  "/help — this guide",
  "/privacy — how your data is handled",
  "/keywords — manage keywords per group",
  "/unsubscribeall — stop following every group",
  "/cancel — cancel a pending keyword",
  "",
  "<b>Setup so you never miss an alert</b>",
  "1. Mute noisy groups — or put them in a folder and mute the folder — so their pings don’t bury my alerts.",
  "2. Open the Huntzz chat, tap its name, go to Notifications, and pick a distinct sound. (Menu names differ slightly between Android and iOS.)",
  "3. Pin the Huntzz chat so alerts stay on top.",
].join("\n");

// Keep this accurate: the bot stores no message text (messages are scanned in
// memory only). It stores user ids, chat ids and keywords.
const PRIVACY_TEXT = [
  "<b>Privacy</b>",
  "",
  "• I read messages only in groups and channels where I’ve been added, and only to check them against members’ keywords.",
  "• I do not store message text — messages are scanned in memory and then discarded.",
  "• I store user ids, group/channel ids, and the keywords you set.",
  "• Any group admin can remove me from a group at any time; that stops all reading there.",
  "",
  "Questions? Message me here anytime.",
].join("\n");

const backKb = () => new InlineKeyboard().text("⬅️ Back", "start_menu");

const startMenu = async () => {
  const me = await bot.api.getMe();
  const kb = new InlineKeyboard()
    .url("➕ Add me to a group", `https://t.me/${me.username}?startgroup=true`)
    .row()
    .text("👥 My groups", "my_groups")
    .row()
    .text("🔑 Keywords", "keywords_menu")
    .row()
    .text("❓ Help", "help_menu")
    .text("🔒 Privacy", "privacy_menu");
  return {
    text: "Hi! I help you catch the messages that matter in your Telegram groups.\n\nAdd me to a group to get started.",
    markup: kb,
  };
};

// --- /start: private chat menu ---
bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const isNew = await upsertUser(ctx.from);
  const view = await startMenu();
  await ctx.reply(view.text, { reply_markup: view.markup });
  if (isNew) await ctx.reply(HELP_TEXT, { parse_mode: "HTML" }); // first-timers get the guide
});

bot.command("help", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await ctx.reply(HELP_TEXT, { parse_mode: "HTML", reply_markup: backKb() });
});

bot.command("privacy", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await ctx.reply(PRIVACY_TEXT, { parse_mode: "HTML", reply_markup: backKb() });
});

bot.callbackQuery("help_menu", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx
    .editMessageText(HELP_TEXT, { parse_mode: "HTML", reply_markup: backKb() })
    .catch(async () => {
      await ctx.reply(HELP_TEXT, { parse_mode: "HTML", reply_markup: backKb() });
    });
});

bot.callbackQuery("privacy_menu", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx
    .editMessageText(PRIVACY_TEXT, { parse_mode: "HTML", reply_markup: backKb() })
    .catch(async () => {
      await ctx.reply(PRIVACY_TEXT, { parse_mode: "HTML", reply_markup: backKb() });
    });
});

bot.callbackQuery("start_menu", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const view = await startMenu();
  await ctx.editMessageText(view.text, { reply_markup: view.markup }).catch(async () => {
    await ctx.reply(view.text, { reply_markup: view.markup });
  });
});

// --- /unsubscribeall (Stage 7): stop following every group, keep keywords ---
bot.command("unsubscribeall", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  const { count } = check(
    "countSubs",
    await supabase
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ctx.from.id)
      .eq("active", true)
  );
  if (!count) {
    await ctx.reply("You're not subscribed to any groups.").catch(() => {});
    return;
  }
  const kb = new InlineKeyboard()
    .text(`✅ Yes, unsubscribe from ${count}`, "unsuball_confirm")
    .row()
    .text("✖️ Cancel", "unsuball_cancel");
  await ctx
    .reply(`Unsubscribe from all ${count} groups? Your keywords are kept.`, { reply_markup: kb })
    .catch(() => {});
});

bot.callbackQuery("unsuball_confirm", async (ctx) => {
  const { data: subs } = check(
    "listSubs",
    await supabase.from("subscriptions").select("chat_id").eq("user_id", ctx.from.id).eq("active", true)
  );
  check(
    "unsubAll",
    await supabase.from("subscriptions").update({ active: false }).eq("user_id", ctx.from.id).eq("active", true)
  );
  for (const s of subs ?? []) invalidateChatCache(s.chat_id);
  await ctx.answerCallbackQuery({ text: "Unsubscribed from all." }).catch(() => {});
  await ctx
    .editMessageText("Done — you're no longer subscribed to any groups. Your keywords are saved for when you come back.")
    .catch(() => {});
});

bot.callbackQuery("unsuball_cancel", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Cancelled." }).catch(() => {});
  await ctx.editMessageText("Okay, nothing changed.").catch(() => {});
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
      .eq("active", true)
      .maybeSingle()
  );
  if (!sub) {
    await ctx.answerCallbackQuery({ text: "You're not subscribed to that group." }).catch(() => {});
    return;
  }
  await setPending(ctx.from.id, PENDING_ACTION_ADD_KEYWORD, chatId);
  await ctx.answerCallbackQuery({ text: "Send me the keyword now." }).catch(() => {});
  await ctx
    .reply('Send me the keyword to watch for in this group (e.g. "job"). Send /cancel to stop.')
    .catch(() => {});
});

bot.command("cancel", async (ctx) => {
  await clearPending(ctx.from.id);
  if (ctx.chat.type === "private") {
    await ctx.reply("Cancelled — no keyword added.").catch(() => {});
  }
});

bot.callbackQuery(/^delkw:(-?\d+):(\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const id = Number(ctx.match[2]);
  check("deleteKeyword", await supabase.from("keywords").delete().eq("id", id).eq("user_id", ctx.from.id));
  invalidateChatCache(chatId);
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
      .select("id, active")
      .eq("user_id", ctx.from.id)
      .eq("chat_id", chatId)
      .maybeSingle()
  );

  if (sub?.active) {
    // Soft unsubscribe: keep the row (and the keywords), just stop alerts.
    check("deactivateSub", await supabase.from("subscriptions").update({ active: false }).eq("id", sub.id));
    await ctx.answerCallbackQuery({ text: "Unsubscribed." }).catch(() => {});
  } else if (sub) {
    // Re-subscribe an existing (soft-unsubscribed) row — no limit check needed.
    check("reactivateSub", await supabase.from("subscriptions").update({ active: true }).eq("id", sub.id));
    await ctx.answerCallbackQuery({ text: "Subscribed ✅" }).catch(() => {});
  } else {
    const { count } = check(
      "countSubs",
      await supabase
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ctx.from.id)
        .eq("active", true)
    );
    if ((count ?? 0) >= MAX_SUBSCRIPTIONS) {
      await ctx
        .answerCallbackQuery({ text: `You can follow at most ${MAX_SUBSCRIPTIONS} groups. Unsubscribe from one first.` })
        .catch(() => {});
      return;
    }
    await upsertUser(ctx.from);
    const { error } = check(
      "addSub",
      await supabase
        .from("subscriptions")
        .upsert({ user_id: ctx.from.id, chat_id: chatId, active: true }, { onConflict: "user_id,chat_id" })
    );
    if (error) {
      await ctx.answerCallbackQuery({ text: "Couldn't save the subscription." }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery({ text: "Subscribed ✅" }).catch(() => {});
  }

  invalidateChatCache(chatId);
  const view = await groupsView(ctx.from.id);
  await ctx.editMessageText(view.text, { reply_markup: view.markup }).catch(() => {});
});

// --- bot added to / removed from a group or channel ---
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  if (chat.type === "private") return;

  const status = ctx.myChatMember.new_chat_member.status;
  const adder = ctx.myChatMember.from;
  invalidateChatCache(chat.id); // registration changes whether this chat can match

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
      // First-time registration: a short, polite notice in the group itself.
      try {
        await bot.api.sendMessage(
          chat.id,
          "Thanks for adding me! I’m Huntzz — I privately alert members when a message here matches keywords they’ve chosen. " +
            "Members: open me and use /keywords to set yours. Admins: send me /privacy to see how data is handled. " +
            "Remove me anytime to stop."
        );
      } catch (err) {
        console.error(`[onboarding] could not post in ${chat.id}: ${err.description ?? err.message}`);
      }
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
    if (!ctx.message.text || ctx.message.text.startsWith("/")) return; // commands handled elsewhere
    const state = await getPending(ctx.from.id);
    if (!state || state.action !== PENDING_ACTION_ADD_KEYWORD) return;
    const target = state.chat_id;
    await clearPending(ctx.from.id);

    const { keyword, truncated } = cleanKeyword(ctx.message.text);
    const problem = keywordError(keyword);
    if (problem) {
      await ctx.reply(`${problem} Send another one, or /cancel.`).catch(() => {});
      return;
    }

    // Per-group keyword cap: an already-saved keyword can always be re-saved.
    const { data: existingKw } = check(
      "findKeyword",
      await supabase
        .from("keywords")
        .select("id")
        .eq("user_id", ctx.from.id)
        .eq("chat_id", target)
        .eq("keyword", keyword)
        .maybeSingle()
    );
    if (!existingKw) {
      const { count } = check(
        "countKeywords",
        await supabase
          .from("keywords")
          .select("id", { count: "exact", head: true })
          .eq("user_id", ctx.from.id)
          .eq("chat_id", target)
      );
      if ((count ?? 0) >= MAX_KEYWORDS_PER_GROUP) {
        await ctx
          .reply(`You've reached the limit of ${MAX_KEYWORDS_PER_GROUP} keywords for this group. Remove one first.`)
          .catch(() => {});
        return;
      }
    }

    const { error } = check(
      "addKeyword",
      await supabase
        .from("keywords")
        .upsert(
          { user_id: ctx.from.id, chat_id: target, keyword },
          { onConflict: "user_id,chat_id,keyword" }
        )
    );
    invalidateChatCache(target);
    await ctx
      .reply(
        error
          ? `Couldn't save the keyword: ${error.message}`
          : `✅ Watching for "${keyword}".${truncated ? " (trimmed to 40 characters)" : ""}`
      )
      .catch(() => {});
    const view = await keywordsView(ctx.from.id, target);
    await ctx.reply(view.text, { reply_markup: view.markup }).catch(() => {});
    return;
  }

  if (chat.type === "group" || chat.type === "supergroup") {
    if (ctx.from?.id === ctx.me.id) return; // ignore the bot's own messages
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    if (DEBUG) console.log(`[${chat.title}] ${ctx.from?.first_name}: ${text}`); // text only when DEBUG
    if (text) {
      if (await shouldDropForAd(chat, text, ctx.from?.id)) return;
      const senderName =
        [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "?";
      await matchAndDeliver(chat, text, {
        senderId: ctx.from?.id,
        senderName,
        messageId: ctx.message.message_id,
      });
    }
  }
});

bot.on("channel_post", async (ctx) => {
  if (ctx.from?.id === ctx.me.id) return; // ignore the bot's own posts
  const text = ctx.channelPost.text ?? ctx.channelPost.caption ?? "";
  if (DEBUG) console.log(`[CHANNEL ${ctx.chat.title}] ${text}`); // text only when DEBUG
  if (text) {
    if (await shouldDropForAd(ctx.chat, text, ctx.from?.id)) return;
    await matchAndDeliver(ctx.chat, text, {
      senderId: ctx.from?.id,
      senderName: null, // sender name is not available for channel posts
      messageId: ctx.channelPost.message_id,
    });
  }
});

// One bad update must never kill polling (Stage 6).
bot.catch((err) => {
  const e = err.error;
  console.error(`[bot] update ${err.ctx?.update?.update_id} failed: ${e?.message ?? e}`);
});

// Graceful shutdown (Stage 6).
const shutdown = async (signal) => {
  console.log(`[bot] ${signal} received, stopping…`);
  try {
    await bot.stop();
  } catch (err) {
    console.error(`[bot] stop failed: ${err?.message ?? err}`);
  }
  process.exit(0);
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

bot.start({
  allowed_updates: ["message", "channel_post", "my_chat_member", "callback_query"],
});
