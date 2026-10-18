export const MAX_KEYWORD_LENGTH = 40;
export const ALERT_PREVIEW_LEN = 200;
export const ALERT_RETENTION_DAYS = 7;
export const MAX_ALERTS_PER_USER = 500;

const WORD_CHAR = /[\p{L}\p{N}]/u;
const AD_PATTERNS = [
  /t\.me\/\+/i,
  /t\.me\/joinchat/i,
  /join (our|my|the) (channel|group)/i,
  /subscribe (to|now)/i,
  /click (the )?link/i,
];
const keywordRegexCache = new Map();

export const normalizeKeyword = (raw) =>
  String(raw).trim().replace(/\s+/g, " ").toLowerCase();

export const cleanKeyword = (raw) => {
  const normalized = normalizeKeyword(raw);
  return {
    keyword: normalized.slice(0, MAX_KEYWORD_LENGTH),
    truncated: normalized.length > MAX_KEYWORD_LENGTH,
  };
};

export const keywordError = (keyword) => {
  if (!keyword) return "That looks empty - send a word or phrase to watch for.";
  if (!WORD_CHAR.test(keyword))
    return "A keyword needs at least one letter or number (punctuation alone won't work).";
  return null;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getKeywordRegex = (keyword) => {
  let regex = keywordRegexCache.get(keyword);
  if (!regex) {
    const pattern = escapeRegex(keyword).replace(/\s+/g, "\\s+");
    regex = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu");
    keywordRegexCache.set(keyword, regex);
  }
  return regex;
};

export const matchesKeyword = (text, keyword) =>
  getKeywordRegex(normalizeKeyword(keyword)).test(String(text));

export const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const messageLink = (chat, messageId) => {
  if (!messageId) return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  if (chat.type === "supergroup" || chat.type === "channel") {
    const id = String(chat.id).replace(/^-100/, "");
    return `https://t.me/c/${id}/${messageId}`;
  }
  return null;
};

export const looksLikeAd = (text) =>
  AD_PATTERNS.some((regex) => regex.test(String(text)));

export const isPaused = (matcher, now = Date.now()) =>
  matcher.pausedUntil != null &&
  new Date(matcher.pausedUntil).getTime() > new Date(now).getTime();

export const inQuietHours = (matcher, now = new Date()) => {
  if (matcher.quietStart == null || matcher.quietEnd == null) return false;
  const start = matcher.quietStart;
  const end = matcher.quietEnd;
  if (start === end) return false;
  let hour;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: matcher.tz || "Africa/Lagos",
      }).format(new Date(now)),
    );
  } catch {
    return false;
  }
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
};

export const shouldSkipDM = (matcher, now = new Date()) =>
  isPaused(matcher, now) || inQuietHours(matcher, now);

export const truncatePreview = (text, maxLength = ALERT_PREVIEW_LEN) => {
  const value = String(text);
  return value.length > maxLength ? value.slice(0, maxLength) + "…" : value;
};

export const duplicateAlertKey = (userId, chatId, messageId) =>
  messageId == null ? null : [userId, chatId, messageId].map(String).join(":");

export const buildPrivacyText = () =>
  [
    "<b>Privacy</b>",
    "",
    "• I read messages only where I’ve been added, and only to check them against members’ keywords.",
    `• For each match, I store a short preview (up to ${ALERT_PREVIEW_LEN} characters), the group name, a link when available, and the matched keywords for ${ALERT_RETENTION_DAYS} days so your inbox works.`,
    `• I store at most ${MAX_ALERTS_PER_USER} alerts per user. Alerts for a group are deleted when you unfollow it or leave it.`,
    "• Nothing is stored for messages that match nobody, and no media is stored.",
    "• I store user ids, group ids, and the keywords you set. This data lives in a database run by the bot’s owner.",
    "• You can clear your inbox or erase everything with /deleteme.",
    "• Any group admin can remove me from a group at any time; that stops all reading there.",
    "• Server logs contain message text only when the owner turns on debug mode.",
    "",
    "Questions? Message me here anytime.",
  ].join("\n");

export const isMemberStatus = (member) =>
  member?.status === "creator" ||
  member?.status === "administrator" ||
  member?.status === "member" ||
  (member?.status === "restricted" && member.is_member === true);

export const fetchMembership = async (api, userId, chatId) =>
  isMemberStatus(await api.getChatMember(chatId, userId));
