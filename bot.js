import "dotenv/config";
import { Bot, InlineKeyboard, Keyboard } from "grammy";
import { createHash } from "node:crypto";
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

// Owner (Stage 2 startup warning, Stage 5 /stats). Optional.
const OWNER_ID = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;

// --- limits + timers (Stage 6) ---
const MAX_KEYWORDS_PER_GROUP = 20;
const MAX_SUBSCRIPTIONS = 50;
const PENDING_TTL_MS = 10 * 60 * 1000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Bot(process.env.BOT_TOKEN);

// --- cached bot identity (username for deep links, privacy-mode flag) ---
let botInfo = null;
const getBotInfo = async () => {
  if (!botInfo) botInfo = await bot.api.getMe();
  return botInfo;
};

// Rate-limit protection (Stage 6): retry 429s and space out bulk sends.
bot.api.config.use(autoRetry());
bot.api.config.use(apiThrottler());

// ===== Screen framework (Stage 3) =====
// Every screen is a plain object: { text, markup, parseMode? }. We always try to
// edit the current message in place, and fall back to a brand-new message (e.g.
// the message is too old, had no text, or came from the reply keyboard).
const answer = (ctx, text) =>
  ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});

const renderScreen = async (ctx, view, { edit = true } = {}) => {
  const opts = { reply_markup: view.markup };
  if (view.parseMode) opts.parse_mode = view.parseMode;
  if (edit) {
    try {
      await ctx.editMessageText(view.text, opts);
      return;
    } catch {
      /* fall through to a new message */
    }
  }
  await ctx.reply(view.text, opts).catch(() => {});
};

// The persistent reply keyboard shown in the private chat.
const mainKeyboard = () =>
  new Keyboard()
    .text("📥 Inbox")
    .text("👥 My groups")
    .text("🏠 Menu")
    .resized()
    .persistent();

// Send a plain private reply that also (re)installs the persistent keyboard.
const replyWithMenu = (ctx, text, extra = {}) =>
  ctx.reply(text, { reply_markup: mainKeyboard(), ...extra }).catch(() => {});

// The exact labels of the reply keyboard, matched before anything else.
const MENU_LABELS = { "📥 Inbox": "inbox", "👥 My groups": "my_groups", "🏠 Menu": "home" };

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
const chatCache = new Map(); // chatId -> { expires, byUser: Map<userId, { keywords, alertAdmins, pausedUntil, quietStart, quietEnd, tz }> }

const invalidateChatCache = (chatId) => invalidateChatCaches(chatId);

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
    byUser.set(row.user_id, {
      keywords: row.keywords ?? [],
      alertAdmins: row.alert_admins === true,
      pausedUntil: row.paused_until ?? null,
      quietStart: row.quiet_start ?? null,
      quietEnd: row.quiet_end ?? null,
      tz: row.tz ?? null,
    });
  }
  chatCache.set(chatId, { expires: Date.now() + CHAT_CACHE_TTL_MS, byUser });
  return byUser;
};

// --- membership cache (Stage 2) ---
// My groups may only reveal chats the user is actually in. We ask Telegram
// getChatMember once per (user, chat) and cache for 5 minutes. A failed lookup
// is treated as "not a member" (never shown), which also avoids leaking titles.
const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;
const membershipCache = new Map(); // `${userId}:${chatId}` -> { expires, isMember }

const rememberMembership = (userId, chatId, isMember) => {
  membershipCache.set(`${userId}:${chatId}`, {
    expires: Date.now() + MEMBERSHIP_CACHE_TTL_MS,
    isMember,
  });
};

const isChatMember = async (userId, chatId) => {
  const key = `${userId}:${chatId}`;
  const cached = membershipCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.isMember;

  let isMember = false;
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    isMember = member.status !== "left" && member.status !== "kicked";
  } catch {
    isMember = false; // API error -> treat as not a member (not shown)
  }
  rememberMembership(userId, chatId, isMember);
  return isMember;
};

// Deep link that opens the bot and offers to follow this chat.
const followDeepLink = async (chatId) =>
  `https://t.me/${(await getBotInfo()).username}?start=f_${chatId}`;

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

  const me = await getBotInfo();

  // Only reveal chats the user is actually a member of. Checked in parallel and
  // cached for 5 minutes; a failed lookup is treated as "not a member".
  const checked = await Promise.all(
    (groups ?? []).map(async (g) => ({ g, isMember: await isChatMember(userId, g.chat_id) }))
  );
  const visible = checked.filter((c) => c.isMember).map((c) => c.g);

  if (!visible.length) {
    return {
      text:
        "I don't know any of your groups yet.\n" +
        "1) Tap the button below.\n" +
        "2) Pick a group.\n" +
        "3) Come back here.\n\n" +
        "I can only read groups I've been added to.",
      markup: new InlineKeyboard()
        .url("➕ Add me to a group", `https://t.me/${me.username}?startgroup=true`)
        .row()
        .text("🏠 Home", "start_menu"),
    };
  }

  const subSet = new Set((subs ?? []).map((s) => s.chat_id));
  const kb = new InlineKeyboard();
  for (const g of visible) {
    kb.text(`${subSet.has(g.chat_id) ? "✅" : "➕"} ${g.title}`, `sub:${g.chat_id}`).row();
  }
  kb.url("➕ Add me to a group", `https://t.me/${me.username}?startgroup=true`).row();
  kb.text("🏠 Home", "start_menu");
  return {
    text: "Tap a group to follow it. ✅ means you follow it.",
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
      text: "You're not following any group yet.\nOpen My groups and follow one first.",
      markup: new InlineKeyboard()
        .text("👥 My groups", "my_groups")
        .row()
        .text("🏠 Home", "start_menu"),
    };
  }

  const kb = new InlineKeyboard();
  for (const s of active) kb.text(`🔑 ${s.groups.title}`, `kw:${s.chat_id}`).row();
  kb.text("🏠 Home", "start_menu");
  return {
    text: "Which group? Tap it to choose the words I watch for you.",
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
      text: "You're not following that group anymore.",
      markup: new InlineKeyboard().text("⬅️ Back", "keywords_menu").text("🏠 Home", "start_menu"),
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
  kb.text("➕ Add a word", `addkw:${chatId}`).row();
  kb.text("⬅️ Back", "keywords_menu").text("🏠 Home", "start_menu");

  return {
    text:
      `Words I watch in "${sub.groups.title}".\n` +
      "When someone writes one of these words, I tell you here.\n" +
      "Tap a word to remove it.\n\n" +
      (kws?.length ? kws.map((k) => `• ${k.keyword}`).join("\n") : "No words yet."),
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

// Returns { state, expired }. `state` is the live pending row (or null); when an
// old row timed out it is deleted and we report `expired` so we can say so.
const getPending = async (userId) => {
  const { data, error } = await supabase
    .from("pending_input")
    .select("action, chat_id, created_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[supabase:getPending]", error.message);
    return { state: null, expired: false };
  }
  if (!data) return { state: null, expired: false };
  if (Date.now() - new Date(data.created_at).getTime() > PENDING_TTL_MS) {
    await clearPending(userId);
    return { state: null, expired: true };
  }
  return { state: data, expired: false };
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

// Drop every cache entry tied to a chat id (matchers, admins, membership).
const invalidateChatCaches = (chatId) => {
  chatCache.delete(chatId);
  adminCache.delete(chatId);
  const suffix = `:${chatId}`;
  for (const key of membershipCache.keys()) {
    if (key.endsWith(suffix)) membershipCache.delete(key);
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

// --- alerts + inbox helpers (Stage 4) ---
// Buckets are keyed by the keyword string, but callbacks carry only a short,
// stable hash (callback data must stay tiny). At read time we resolve the hash
// back to one of the user's own distinct alert keywords.
const keywordHash = (keyword) => createHash("sha1").update(keyword).digest("hex").slice(0, 10);

const ALERT_PREVIEW_LEN = 200;
const MAX_ALERTS_PER_USER = 500;
const ALERTS_PER_PAGE = 5;

const timeAgo = (iso) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const isPaused = (matcher) =>
  matcher.pausedUntil != null && new Date(matcher.pausedUntil).getTime() > Date.now();

// Quiet hours in the user's timezone. Hours are 0-23 and the window may wrap
// past midnight (e.g. 22 -> 6).
const inQuietHours = (matcher) => {
  if (matcher.quietStart == null || matcher.quietEnd == null) return false;
  const s = matcher.quietStart;
  const e = matcher.quietEnd;
  if (s === e) return false;
  let hour;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: matcher.tz || "Africa/Lagos",
      }).format(new Date())
    );
  } catch {
    return false;
  }
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
};

// Paused or quiet hours: still save the alert to the inbox, just don't ping.
const shouldSkipDM = (matcher) => isPaused(matcher) || inQuietHours(matcher);

// Keep only the newest MAX_ALERTS_PER_USER rows for a user.
const enforceAlertCap = async (userId) => {
  const { data } = check(
    "alertIds",
    await supabase
      .from("alerts")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(MAX_ALERTS_PER_USER, MAX_ALERTS_PER_USER + 999)
  );
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length) check("trimAlerts", await supabase.from("alerts").delete().in("id", ids));
};

// Alerts live for 7 days (Stage 4 retention). Run at startup and hourly.
const ALERT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const purgeOldAlerts = async () => {
  const cutoff = new Date(Date.now() - ALERT_TTL_MS).toISOString();
  check("purgeAlerts", await supabase.from("alerts").delete().lt("created_at", cutoff));
};

const alertKeyboard = (hit, link) => {
  const kb = new InlineKeyboard();
  if (link) kb.url("Open message", link).row();
  if (hit.words.length) {
    kb.text(`📥 See all for “${hit.words[0]}”`, `ik:${keywordHash(hit.words[0])}`);
  } else {
    kb.text("📥 See all admin posts", "ikad");
  }
  return kb;
};

const sendAlertDM = async (userId, { chat, hit, preview, link, senderName }) => {
  // Escape at display time only; the stored preview stays raw.
  const lines = [`🔔 <b>${escapeHtml(chat.title ?? "Group")}</b>`];
  if (senderName) lines.push(`${escapeHtml(senderName)}: ${escapeHtml(preview)}`);
  else lines.push(escapeHtml(preview));
  lines.push(`\n${hit.words.length ? "Keyword: " + escapeHtml(hit.words.join(", ")) : "📢 Admin post"}`);
  if (!link) lines.push("No link: this is a basic group.");

  try {
    await bot.api.sendMessage(userId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: alertKeyboard(hit, link),
    });
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
};

const matchAndDeliver = async (chat, text, { senderId, senderName, messageId }) => {
  const byUser = await getChatMatchers(chat.id);
  if (!byUser.size) return;

  // "Alert me about admin posts too" is the only reason we need to know who is
  // an admin, so skip the lookup entirely when nobody enabled the toggle.
  const isChannel = chat.type === "channel";
  const needsAdminCheck = isChannel || [...byUser.values()].some((m) => m.alertAdmins);
  let isAdmin = isChannel;
  if (!isChannel && needsAdminCheck) {
    const adminIds = await getChatAdminIds(chat.id);
    isAdmin = senderId !== undefined && adminIds.has(senderId);
  }

  // Store a short raw preview (<= 200 chars). Escaped only when displayed.
  const preview = text.length > ALERT_PREVIEW_LEN ? text.slice(0, ALERT_PREVIEW_LEN) + "…" : text;
  const link = messageLink(chat, messageId);

  const hits = new Map(); // userId -> { words: string[], matcher, adminPost }
  for (const [userId, matcher] of byUser) {
    if (userId === senderId) continue; // never alert a user about their own message
    const matched = matcher.keywords.filter((keyword) => keywordRegex(keyword).test(text));
    if (matched.length) hits.set(userId, { words: matched, matcher, adminPost: false });
    // Toggle-driven: an admin post (or any channel post) with no keyword match.
    else if (isAdmin && matcher.alertAdmins) hits.set(userId, { words: [], matcher, adminPost: true });
  }

  for (const [userId, hit] of hits) {
    const { error } = check(
      "insertAlert",
      await supabase.from("alerts").insert({
        user_id: userId,
        chat_id: chat.id,
        message_id: messageId ?? null,
        chat_title: chat.title ?? null,
        keywords: hit.words,
        preview,
        link,
        admin_post: hit.adminPost,
      })
    );
    if (!error) await enforceAlertCap(userId);

    // Paused or quiet: the alert is still in the inbox; we just don't ping.
    if (shouldSkipDM(hit.matcher)) continue;
    await sendAlertDM(userId, { chat, hit, preview, link, senderName });
  }
};

// --- help text (Stage 3) ---
const HELP_TEXT = [
  "<b>What I do</b>",
  "I watch your groups for words you choose. When someone writes one, I message you here.",
  "",
  "<b>Set up in 3 steps</b>",
  "1. Add me to a group.",
  "2. Tap “👥 My groups” and follow it.",
  "3. Tap “🔑 My keywords” and add words to watch.",
  "",
  "<b>The buttons below the text box</b>",
  "📥 Inbox — your alerts",
  "👥 My groups — follow or unfollow groups",
  "🏠 Menu — the start screen",
  "",
  "<b>Commands</b>",
  "/start — start screen",
  "/groups — your groups",
  "/keywords — your words",
  "/help — this help",
  "/privacy — how I handle your data",
  "/cancel — stop adding a word",
  "",
  "Tip: to never miss an alert, mute noisy groups and give this chat a special sound. Tap “🔊 Make alerts loud” on the setup screen for steps.",
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

// Posted once, inside a group/supergroup, the first time it is registered.
const GROUP_NOTICE_TEXT =
  "Hi! I'm Huntzz. I let members get a private alert when a word they chose is posted here. " +
  "I only check messages against members' keywords and keep short previews of matches for 7 days. " +
  "Tap below to get alerts, or send /privacy to me in private.";

const getAlertsButton = async (chatId) =>
  new InlineKeyboard().url("👉 Get alerts from this group", await followDeepLink(chatId));

// "/start f_<chatId>" confirmation. Never reveals the title to a non-member.
const showFollowConfirm = async (ctx, chatId) => {
  if (!Number.isFinite(chatId)) return;
  const isMember = await isChatMember(ctx.from.id, chatId);
  if (!isMember) {
    await ctx
      .reply("I can only show a group to its members. Open My groups to find the groups you're already in.")
      .catch(() => {});
    return;
  }
  const { data: g } = check(
    "findGroup",
    await supabase.from("groups").select("title, active").eq("chat_id", chatId).maybeSingle()
  );
  if (!g || !g.active) {
    await ctx.reply("That group isn't available right now.").catch(() => {});
    return;
  }
  const kb = new InlineKeyboard()
    .text("✅ Follow", `sub:${chatId}`)
    .row()
    .text("No thanks", "start_menu");
  await ctx.reply(`Follow "${g.title}"?`, { reply_markup: kb }).catch(() => {});
};

// --- home + setup (Stage 3) ---
const unreadCount = async (userId) => {
  const { count } = check(
    "countUnread",
    await supabase
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_read", false)
  );
  return count ?? 0;
};

// Where is this user in setup? "Finished" = steps 1-3 (decision: step 4 optional).
// Step 1 is auto-satisfied by any subscription; only when there are none do we
// live-check membership, stopping at the first group the user is a member of.
const setupState = async (userId) => {
  const { count: subCount } = check(
    "countSubs",
    await supabase
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("active", true)
  );
  const { count: kwCount } = check(
    "countKeywords",
    await supabase
      .from("keywords")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
  );
  const { data: userRow } = check(
    "getUser",
    await supabase.from("users").select("setup_sound_done").eq("user_id", userId).maybeSingle()
  );

  const hasSub = (subCount ?? 0) > 0;
  const hasKeyword = (kwCount ?? 0) > 0;
  let inGroup = hasSub;
  if (!inGroup) {
    const { data: groups } = check(
      "listGroups",
      await supabase.from("groups").select("chat_id").eq("active", true)
    );
    for (const g of groups ?? []) {
      if (await isChatMember(userId, g.chat_id)) {
        inGroup = true;
        break;
      }
    }
  }

  const soundDone = userRow?.setup_sound_done === true;
  const finished = inGroup && hasSub && hasKeyword;
  let next = null;
  if (!inGroup) next = "group";
  else if (!hasSub) next = "follow";
  else if (!hasKeyword) next = "keyword";

  return { inGroup, hasSub, hasKeyword, soundDone, finished, next };
};

const STEP_LABEL = (done) => (done ? "✅" : "⬜");

const setupChecklistView = async (userId) => {
  const s = await setupState(userId);
  const doneCount = [s.inGroup, s.hasSub, s.hasKeyword, s.soundDone].filter(Boolean).length;
  const text =
    `📋 Setup — ${doneCount}/4 done\n\n` +
    `${STEP_LABEL(s.inGroup)} 1. Add me to a group\n` +
    `${STEP_LABEL(s.hasSub)} 2. Follow a group\n` +
    `${STEP_LABEL(s.hasKeyword)} 3. Add a keyword\n` +
    `${STEP_LABEL(s.soundDone)} 4. Make my alerts loud`;

  const me = await getBotInfo();
  const kb = new InlineKeyboard();
  if (!s.inGroup) {
    kb.url("➕ Add me to a group", `https://t.me/${me.username}?startgroup=true`).row();
  } else if (!s.hasSub) {
    kb.text("👥 Pick a group", "my_groups").row();
  } else if (!s.hasKeyword) {
    kb.text("🔑 Add a keyword", "keywords_menu").row();
  }
  if (!s.soundDone) kb.text("🔊 Make alerts loud", "sound_guide").row();
  kb.text("🏠 Home", "start_menu");
  return { text, markup: kb };
};

const soundGuideView = () => ({
  text:
    "🔊 Make alerts loud\n\n" +
    "Group chatter can bury my messages. Two quick tips:\n\n" +
    "1) Mute noisy groups — or put them in a folder and mute the folder.\n" +
    "2) Open this Huntzz chat, tap my name at the top, choose Notifications, and pick a special sound.\n" +
    "   (Menu names differ a little on Android and iPhone.)\n\n" +
    "Then you'll never miss an alert.",
  markup: new InlineKeyboard()
    .text("✅ Done, I did this", "sound_done")
    .row()
    .text("Skip", "sound_skip")
    .row()
    .text("🏠 Home", "start_menu"),
});

const inboxEmptyView = () => ({
  text:
    "📥 Your inbox is empty.\n\n" +
    "When a group matches a keyword, the message shows up here.\n" +
    "Follow a group and add a keyword to start.",
  markup: new InlineKeyboard()
    .text("👥 My groups", "my_groups")
    .row()
    .text("🔑 Add a keyword", "keywords_menu")
    .row()
    .text("🏠 Home", "start_menu"),
});

// --- inbox (Stage 4) ---
const totalAlertCount = async (userId, unreadOnly) => {
  let q = supabase.from("alerts").select("id", { count: "exact", head: true }).eq("user_id", userId);
  if (unreadOnly) q = q.eq("is_read", false);
  const { count } = check(unreadOnly ? "countUnreadAll" : "countAll", await q);
  return count ?? 0;
};

const inboxView = async (userId) => {
  const { data: kwRows } = check("inboxCounts", await supabase.rpc("inbox_counts", { p_user_id: userId }));
  const { data: adminRows } = check("inboxAdminCounts", await supabase.rpc("inbox_admin_counts", { p_user_id: userId }));
  const buckets = kwRows ?? [];
  const admin = adminRows?.[0] ?? { total: 0, unread: 0 };
  const total = await totalAlertCount(userId, false);
  const unread = await totalAlertCount(userId, true);

  if (!total) return inboxEmptyView();

  const kb = new InlineKeyboard();
  for (const b of buckets) kb.text(`🔑 ${b.keyword} (${b.unread})`, `ik:${keywordHash(b.keyword)}`).row();
  if (Number(admin.total) > 0) kb.text(`📢 Admin posts (${admin.unread})`, "ikad").row();
  kb.text("📨 All messages", "ikall").row();
  kb.text("✅ Mark all read", "inbox_read_all").row();
  kb.text("🗑 Clear inbox", "inbox_clear").row();
  kb.text("🏠 Home", "start_menu");

  return {
    text: `📥 Inbox\n${unread} new · ${total} total\n\nTap a word to see those messages.`,
    markup: kb,
  };
};

const loadAlertsPage = async (userId, mode, keyword, page) => {
  let q = supabase
    .from("alerts")
    .select("id, chat_title, preview, link, is_read, created_at", { count: "exact" })
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(page * ALERTS_PER_PAGE, page * ALERTS_PER_PAGE + ALERTS_PER_PAGE - 1);
  if (mode === "kw") q = q.contains("keywords", [keyword]);
  else if (mode === "ad") q = q.eq("admin_post", true);
  const { data, count } = check("alertsPage", await q);
  return { rows: data ?? [], count: count ?? 0 };
};

const alertsPageNav = (mode, key, page) => `ikp:${mode}:${key}:${page}`;

const alertsPageView = async (userId, mode, keyword, page) => {
  const { rows, count } = await loadAlertsPage(userId, mode, keyword, page);

  // Seeing the page marks its items as read (comment: intentional side effect).
  const ids = rows.filter((a) => !a.is_read).map((a) => a.id);
  if (ids.length) check("markRead", await supabase.from("alerts").update({ is_read: true }).in("id", ids));

  const title = mode === "kw" ? `🔑 ${keyword}` : mode === "ad" ? "📢 Admin posts" : "📨 All messages";
  const back = new InlineKeyboard();

  if (!rows.length) {
    back.text("⬅️ Inbox", "inbox").text("🏠 Home", "start_menu");
    return { text: `${title}\n\nNothing here yet.`, markup: back };
  }

  const lines = rows.map((a, i) => {
    const n = page * ALERTS_PER_PAGE + i + 1;
    const flag = a.is_read ? "" : "🆕 ";
    const where = `${flag}${escapeHtml(a.chat_title ?? "Group")} · ${timeAgo(a.created_at)}`;
    const prev = escapeHtml((a.preview ?? "").slice(0, 120));
    return `${n}. ${where}\n${prev}${a.link ? "" : "\n· no link"}`;
  });

  const kb = new InlineKeyboard();
  let hasNumbers = false;
  rows.forEach((a, i) => {
    if (a.link) {
      kb.url(String(page * ALERTS_PER_PAGE + i + 1), a.link);
      hasNumbers = true;
    }
  });
  if (hasNumbers) kb.row();

  const key = mode === "kw" ? keywordHash(keyword) : "0";
  if (page > 0) kb.text("⬅️ Newer", alertsPageNav(mode, key, page - 1));
  if ((page + 1) * ALERTS_PER_PAGE < count) kb.text("Older ➡️", alertsPageNav(mode, key, page + 1));
  if (page > 0 || (page + 1) * ALERTS_PER_PAGE < count) kb.row();
  kb.text("⬅️ Inbox", "inbox").text("🏠 Home", "start_menu");

  return { text: `${title}\n\n${lines.join("\n\n")}`, markup: kb };
};

// Resolve a bucket hash back to one of this user's own alert keywords.
const resolveKeyword = async (userId, hash) => {
  const { data } = check("inboxCounts", await supabase.rpc("inbox_counts", { p_user_id: userId }));
  for (const row of data ?? []) if (keywordHash(row.keyword) === hash) return row.keyword;
  return null;
};

const homeView = async (firstName, userId) => {
  const s = await setupState(userId);
  const me = await getBotInfo();

  if (!s.finished) {
    const kb = new InlineKeyboard();
    if (s.next === "group") {
      kb.url("➕ Add me to a group", `https://t.me/${me.username}?startgroup=true`).row();
    } else if (s.next === "follow") {
      kb.text("👥 Pick a group to follow", "my_groups").row();
    } else if (s.next === "keyword") {
      kb.text("🔑 Add a keyword", "keywords_menu").row();
    }
    kb.text("📋 Setup steps", "setup_menu").row();
    kb.text("❓ Help", "help_menu");
    return {
      text:
        `Hi ${firstName}! I tell you when something important is posted in your groups.\n` +
        "Let's get you set up. It takes 2 minutes.",
      markup: kb,
    };
  }

  const n = await unreadCount(userId);
  const kb = new InlineKeyboard()
    .text(`📥 Inbox (${n})`, "inbox")
    .row()
    .text("👥 My groups", "my_groups")
    .row()
    .text("🔑 My keywords", "keywords_menu")
    .row()
    .text("❓ Help", "help_menu");
  return {
    text:
      n === 0
        ? `Hi ${firstName}! You have no new alerts.`
        : `Hi ${firstName}! You have ${n} new alert${n === 1 ? "" : "s"}.`,
    markup: kb,
  };
};

// --- /start: private chat menu (optionally with an f_<chatId> deep link) ---
bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const isNew = await upsertUser(ctx.from);
  await renderScreen(ctx, await homeView(ctx.from.first_name, ctx.from.id), { edit: false });

  if (isNew) {
    // First run: install the persistent keyboard and open the checklist.
    await replyWithMenu(ctx, "Tip: use the buttons below the text box any time. 👇");
    await renderScreen(ctx, await setupChecklistView(ctx.from.id), { edit: false });
  }

  const payload = (typeof ctx.match === "string" ? ctx.match : "").trim();
  if (payload.startsWith("f_")) await showFollowConfirm(ctx, Number(payload.slice(2)));
});

const showHome = async (ctx, edit = true) => {
  await renderScreen(ctx, await homeView(ctx.from.first_name, ctx.from.id), { edit });
};

// /menu re-installs the persistent keyboard, then shows Home.
bot.command(["menu", "home"], async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await replyWithMenu(ctx, "Your menu is ready. 👇");
  await showHome(ctx, false);
});

// /groups is in the command menu; /mygroups is a hidden alias.
bot.command(["groups", "mygroups"], async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await renderScreen(ctx, await groupsView(ctx.from.id), { edit: false });
});

bot.command("setup", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await renderScreen(ctx, await setupChecklistView(ctx.from.id), { edit: false });
});

const helpView = () => ({
  text: HELP_TEXT,
  parseMode: "HTML",
  markup: new InlineKeyboard().text("🔒 Privacy", "privacy_menu").text("🏠 Home", "start_menu"),
});

const privacyView = () => ({
  text: PRIVACY_TEXT,
  parseMode: "HTML",
  markup: new InlineKeyboard().text("🏠 Home", "start_menu"),
});

bot.command("help", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await renderScreen(ctx, helpView(), { edit: false });
});

bot.command("privacy", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await renderScreen(ctx, privacyView(), { edit: false });
});

bot.callbackQuery("help_menu", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, helpView());
});

bot.callbackQuery("privacy_menu", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, privacyView());
});

bot.callbackQuery("start_menu", async (ctx) => {
  await answer(ctx);
  await showHome(ctx);
});

bot.callbackQuery("setup_menu", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, await setupChecklistView(ctx.from.id));
});

bot.callbackQuery("sound_guide", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, soundGuideView());
});

// Step 4 is optional; both "Done" and "Skip" mark it as handled.
const markSoundDone = async (ctx, msg) => {
  check(
    "setSoundDone",
    await supabase.from("users").update({ setup_sound_done: true }).eq("user_id", ctx.from.id)
  );
  await answer(ctx, msg);
  await renderScreen(ctx, await homeView(ctx.from.first_name, ctx.from.id));
};

bot.callbackQuery("sound_done", (ctx) => markSoundDone(ctx, "Nice — you're all set!"));
bot.callbackQuery("sound_skip", (ctx) => markSoundDone(ctx, "Okay, skipped."));

// --- inbox (Stage 4) ---
bot.callbackQuery("inbox", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, await inboxView(ctx.from.id));
});

bot.command("inbox", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await renderScreen(ctx, await inboxView(ctx.from.id), { edit: false });
});

bot.callbackQuery(/^ik:([0-9a-f]{10})$/, async (ctx) => {
  await answer(ctx);
  const keyword = await resolveKeyword(ctx.from.id, ctx.match[1]);
  if (!keyword) {
    await renderScreen(ctx, await inboxView(ctx.from.id));
    return;
  }
  await renderScreen(ctx, await alertsPageView(ctx.from.id, "kw", keyword, 0));
});

bot.callbackQuery("ikad", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, await alertsPageView(ctx.from.id, "ad", null, 0));
});

bot.callbackQuery("ikall", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, await alertsPageView(ctx.from.id, "all", null, 0));
});

bot.callbackQuery(/^ikp:(kw|ad|all):([0-9a-f]{10}|0):(\d+)$/, async (ctx) => {
  await answer(ctx);
  const [, mode, key, pageStr] = ctx.match;
  const page = Number(pageStr);
  let keyword = null;
  if (mode === "kw") {
    keyword = await resolveKeyword(ctx.from.id, key);
    if (!keyword) {
      await renderScreen(ctx, await inboxView(ctx.from.id));
      return;
    }
  }
  await renderScreen(ctx, await alertsPageView(ctx.from.id, mode, keyword, page));
});

bot.callbackQuery("inbox_read_all", async (ctx) => {
  check(
    "readAll",
    await supabase.from("alerts").update({ is_read: true }).eq("user_id", ctx.from.id).eq("is_read", false)
  );
  await answer(ctx, "All read ✅");
  await renderScreen(ctx, await inboxView(ctx.from.id));
});

bot.callbackQuery("inbox_clear", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, {
    text: "Clear your whole inbox? This can't be undone.",
    markup: new InlineKeyboard()
      .text("✅ Yes, clear it", "inbox_clear_yes")
      .row()
      .text("✖️ Cancel", "inbox"),
  });
});

bot.callbackQuery("inbox_clear_yes", async (ctx) => {
  check("clearInbox", await supabase.from("alerts").delete().eq("user_id", ctx.from.id));
  await answer(ctx, "Inbox cleared.");
  await renderScreen(ctx, await inboxView(ctx.from.id));
});

// --- /unsubscribeall: stop following every group, keep keywords ---
const unsubAllView = (count) => ({
  text: `Unfollow all ${count} groups? Your keywords are kept.`,
  markup: new InlineKeyboard()
    .text(`✅ Yes, unfollow ${count}`, "unsuball_confirm")
    .row()
    .text("✖️ Cancel", "start_menu"),
});

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
    await renderScreen(
      ctx,
      {
        text: "You're not following any groups yet.",
        markup: new InlineKeyboard().text("👥 My groups", "my_groups").text("🏠 Home", "start_menu"),
      },
      { edit: false }
    );
    return;
  }
  await renderScreen(ctx, unsubAllView(count), { edit: false });
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
  // Unfollowing drops that chat's alerts from the inbox (Stage 4 retention).
  check("clearAlertsOnUnsubAll", await supabase.from("alerts").delete().eq("user_id", ctx.from.id));
  await answer(ctx, "Unfollowed all.");
  await renderScreen(ctx, {
    text:
      "Done — you're no longer following any groups.\n" +
      "Your keywords are saved for when you come back.",
    markup: new InlineKeyboard().text("👥 My groups", "my_groups").row().text("🏠 Home", "start_menu"),
  });
});

bot.callbackQuery("unsuball_cancel", async (ctx) => {
  await answer(ctx, "Cancelled.");
  await showHome(ctx);
});

// --- keywords menu (command + back button) ---
bot.command("keywords", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await upsertUser(ctx.from);
  await renderScreen(ctx, await keywordsMenuView(ctx.from.id), { edit: false });
});

bot.callbackQuery("keywords_menu", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, await keywordsMenuView(ctx.from.id));
});

bot.callbackQuery(/^kw:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  await answer(ctx);
  await renderScreen(ctx, await keywordsView(ctx.from.id, chatId));
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
    await answer(ctx, "You're not following that group anymore.");
    return;
  }
  await setPending(ctx.from.id, PENDING_ACTION_ADD_KEYWORD, chatId);
  await answer(ctx, "Send me the word now.");
  await replyWithMenu(ctx, 'Send me a word or phrase to watch for (for example: "job"). Send /cancel to stop.');
});

bot.command("cancel", async (ctx) => {
  await clearPending(ctx.from.id);
  if (ctx.chat.type === "private") await replyWithMenu(ctx, "Cancelled — no word added.");
});

bot.callbackQuery(/^delkw:(-?\d+):(\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const id = Number(ctx.match[2]);
  check("deleteKeyword", await supabase.from("keywords").delete().eq("id", id).eq("user_id", ctx.from.id));
  invalidateChatCache(chatId);
  await answer(ctx, "Removed.");
  await renderScreen(ctx, await keywordsView(ctx.from.id, chatId));
});

// --- My groups ---
bot.callbackQuery("my_groups", async (ctx) => {
  await answer(ctx);
  await renderScreen(ctx, await groupsView(ctx.from.id));
});

// --- subscribe / unsubscribe with membership check ---
bot.callbackQuery(/^sub:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);

  let member;
  try {
    member = await bot.api.getChatMember(chatId, ctx.from.id);
  } catch {
    await answer(ctx, "I couldn't check your membership in that group.");
    return;
  }
  if (member.status === "left" || member.status === "kicked") {
    rememberMembership(ctx.from.id, chatId, false);
    await answer(ctx, "You're not a member of that group anymore.");
    return;
  }
  rememberMembership(ctx.from.id, chatId, true);

  const { data: sub } = check(
    "findSub",
    await supabase
      .from("subscriptions")
      .select("id, active")
      .eq("user_id", ctx.from.id)
      .eq("chat_id", chatId)
      .maybeSingle()
  );

  let nowFollowing = false;

  if (sub?.active) {
    // Soft unfollow: keep the row (and the keywords), just stop alerts.
    check("deactivateSub", await supabase.from("subscriptions").update({ active: false }).eq("id", sub.id));
    // Drop this chat's alerts from the inbox (Stage 4 retention).
    check(
      "clearAlertsOnUnsub",
      await supabase.from("alerts").delete().eq("user_id", ctx.from.id).eq("chat_id", chatId)
    );
    await answer(ctx, "Unfollowed.");
  } else if (sub) {
    // Re-follow an existing (soft-unfollowed) row — no limit check needed.
    check("reactivateSub", await supabase.from("subscriptions").update({ active: true }).eq("id", sub.id));
    await answer(ctx, "Following ✅");
    nowFollowing = true;
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
      await answer(ctx, `You can follow at most ${MAX_SUBSCRIPTIONS} groups. Unfollow one first.`);
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
      await answer(ctx, "Couldn't save that. Please try again.");
      return;
    }
    await answer(ctx, "Following ✅");
    nowFollowing = true;
  }

  invalidateChatCache(chatId);

  if (nowFollowing) {
    const { data: g } = check(
      "findGroup",
      await supabase.from("groups").select("title").eq("chat_id", chatId).maybeSingle()
    );
    const title = g?.title ?? "this group";
    await renderScreen(ctx, {
      text: `✅ You now follow "${title}".\nNext: choose words to watch.`,
      markup: new InlineKeyboard()
        .text("🔑 Choose words", `kw:${chatId}`)
        .row()
        .text("👥 Back to groups", "my_groups")
        .row()
        .text("🏠 Home", "start_menu"),
    });
  } else {
    await renderScreen(ctx, await groupsView(ctx.from.id));
  }
});

// --- bot added to / removed from a group or channel ---
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  if (chat.type === "private") return;

  const status = ctx.myChatMember.new_chat_member.status;
  const adder = ctx.myChatMember.from;
  invalidateChatCaches(chat.id); // registration changes whether this chat can match

  if (status === "member" || status === "administrator") {
    await upsertUser(adder);
    const { data: existing, error } = await supabase
      .from("groups")
      .select("chat_id")
      .eq("chat_id", chat.id)
      .maybeSingle();
    if (error) console.error("[supabase:findGroup]", error.message);

    const alertsKb = await getAlertsButton(chat.id);

    if (existing) {
      check("activateGroup", await supabase.from("groups").update({ active: true }).eq("chat_id", chat.id));
      await bot.api
        .sendMessage(
          adder.id,
          `"${chat.title}" is already registered.`,
          { reply_markup: alertsKb }
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
      // The adder gets a private "ready" DM with a follow button.
      await bot.api
        .sendMessage(adder.id, `✅ ${chat.title} is ready. Tap to follow it yourself.`, {
          reply_markup: alertsKb,
        })
        .catch(() => {});

      // First time only, and only real groups (not channels): a one-off notice.
      if (chat.type === "group" || chat.type === "supergroup") {
        try {
          await bot.api.sendMessage(chat.id, GROUP_NOTICE_TEXT, { reply_markup: alertsKb });
        } catch (err) {
          // Harmless if the bot cannot post (e.g. no permission).
          console.error(`[notice] could not post in ${chat.id}: ${err?.description ?? err?.message}`);
        }
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

    // The persistent reply-keyboard labels act like buttons. Match them first,
    // before treating the text as a pending keyword.
    const menuAction = MENU_LABELS[ctx.message.text.trim()];
    if (menuAction === "inbox") {
      await renderScreen(ctx, await inboxView(ctx.from.id), { edit: false });
      return;
    }
    if (menuAction === "my_groups") {
      await renderScreen(ctx, await groupsView(ctx.from.id), { edit: false });
      return;
    }
    if (menuAction === "home") {
      await renderScreen(ctx, await homeView(ctx.from.first_name, ctx.from.id), { edit: false });
      return;
    }

    const { state, expired } = await getPending(ctx.from.id);
    if (expired) {
      await replyWithMenu(ctx, "That took a while. Tap “➕ Add a word” to try again.");
      return;
    }
    if (!state || state.action !== PENDING_ACTION_ADD_KEYWORD) {
      await renderScreen(
        ctx,
        {
          text: "I didn't understand that. Tap a button below.",
          markup: new InlineKeyboard().text("🏠 Home", "start_menu"),
        },
        { edit: false }
      );
      return;
    }
    const target = state.chat_id;

    const { keyword, truncated } = cleanKeyword(ctx.message.text);
    const problem = keywordError(keyword);
    if (problem) {
      // Keep the pending row so the user can try again right away.
      await replyWithMenu(ctx, `${problem} Send another one, or /cancel.`);
      return;
    }
    await clearPending(ctx.from.id);

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
        await replyWithMenu(
          ctx,
          `You've reached the limit of ${MAX_KEYWORDS_PER_GROUP} words for this group. Remove one first.`
        );
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
    if (error) console.error("[supabase:addKeyword]", error.message);
    await replyWithMenu(
      ctx,
      error
        ? "Couldn't save that word. Please try again."
        : `✅ Watching for "${keyword}".${truncated ? " (trimmed to 40 characters)" : ""}`
    );
    await renderScreen(ctx, await keywordsView(ctx.from.id, target), { edit: false });
    return;
  }

  if (chat.type === "group" || chat.type === "supergroup") {
    // A basic group upgraded to a supergroup: Telegram sends a service message
    // carrying the new chat id. Move every row to the new id (idempotent) and
    // drop caches for both ids. Log without any message text.
    if (ctx.message.migrate_to_chat_id) {
      const oldId = chat.id;
      const newId = ctx.message.migrate_to_chat_id;
      check("migrateChat", await supabase.rpc("migrate_chat", { p_old: oldId, p_new: newId }));
      invalidateChatCaches(oldId);
      invalidateChatCaches(newId);
      console.log(`[migrate] chat ${oldId} -> ${newId}`);
      return;
    }
    if (ctx.message.migrate_from_chat_id) {
      const oldId = ctx.message.migrate_from_chat_id;
      const newId = chat.id;
      check("migrateChat", await supabase.rpc("migrate_chat", { p_old: oldId, p_new: newId }));
      invalidateChatCaches(oldId);
      invalidateChatCaches(newId);
      console.log(`[migrate] chat ${oldId} -> ${newId}`);
      return;
    }

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

// Startup safety check (Stage 2): privacy mode makes the bot blind to group
// messages. Warn loudly, and DM the owner once if OWNER_ID is configured.
const startupCheck = async () => {
  try {
    const me = await getBotInfo();
    if (me.can_read_all_group_messages === false) {
      console.warn(
        "\n*** WARNING: privacy mode is ON — Huntzz cannot read normal group messages. ***\n" +
          "Fix: talk to @BotFather -> /setprivacy -> this bot -> Disable, then remove and re-add the bot to your groups.\n"
      );
      if (OWNER_ID) {
        await bot.api
          .sendMessage(
            OWNER_ID,
            "⚠️ Huntzz can't read group messages because privacy mode is ON.\n" +
              "Fix: @BotFather → /setprivacy → Disable, then remove and re-add the bot to your groups."
          )
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[startup] getMe failed: ${err?.message ?? err}`);
  }

  // Register the visible command menu (Stage 3; Stage 5 adds pause/deleteme).
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Start screen" },
      { command: "inbox", description: "Your alerts" },
      { command: "groups", description: "Your groups" },
      { command: "keywords", description: "Your words" },
      { command: "help", description: "How this works" },
      { command: "privacy", description: "How your data is handled" },
    ]);
  } catch (err) {
    console.error(`[startup] setMyCommands failed: ${err?.message ?? err}`);
  }
};

await startupCheck();

// Retention: purge expired alerts now, and once an hour after that.
await purgeOldAlerts();
setInterval(() => purgeOldAlerts().catch(() => {}), 60 * 60 * 1000);

bot.start({
  allowed_updates: ["message", "channel_post", "my_chat_member", "callback_query"],
});
