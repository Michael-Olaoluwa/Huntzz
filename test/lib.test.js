import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERT_PREVIEW_LEN,
  ALERT_RETENTION_DAYS,
  MAX_ALERTS_PER_USER,
  buildPrivacyText,
  cleanKeyword,
  duplicateAlertKey,
  escapeHtml,
  fetchMembership,
  inQuietHours,
  isMemberStatus,
  keywordError,
  looksLikeAd,
  matchesKeyword,
  messageLink,
  normalizeKeyword,
  truncatePreview,
} from "../lib.js";

test("whole-word matching rejects latest but matches test", () => {
  assert.equal(matchesKeyword("latest", "test"), false);
  assert.equal(matchesKeyword("a TEST, please", "test"), true);
});

test("matching handles phrases, punctuation, and non-English boundaries", () => {
  assert.equal(matchesKeyword("class   cancelled!", "class cancelled"), true);
  assert.equal(matchesKeyword("myjob job.", "job"), true);
  assert.equal(matchesKeyword("caféteria", "cafe"), false);
  assert.equal(matchesKeyword("cafe, café", "cafe"), true);
});

test("keyword normalization and length cap are stable", () => {
  assert.equal(normalizeKeyword("  Class   CANCELLED "), "class cancelled");
  const result = cleanKeyword("A".repeat(45));
  assert.equal(result.keyword.length, 40);
  assert.equal(result.truncated, true);
  assert.match(keywordError("!!!"), /letter or number/);
});

test("HTML escaping protects alert markup", () => {
  assert.equal(escapeHtml("<a & b>"), "&lt;a &amp; b&gt;");
});

test("message links distinguish usernames, supergroups, and basic groups", () => {
  assert.equal(
    messageLink({ username: "publicchat", type: "supergroup" }, 12),
    "https://t.me/publicchat/12",
  );
  assert.equal(
    messageLink({ id: -10012345, type: "supergroup" }, 12),
    "https://t.me/c/12345/12",
  );
  assert.equal(messageLink({ id: -12345, type: "group" }, 12), null);
});

test("ad patterns detect configured invitation language", () => {
  assert.equal(looksLikeAd("subscribe now"), true);
  assert.equal(looksLikeAd("class starts tomorrow"), false);
});

test("quiet hours support overnight windows and timezones", () => {
  const matcher = { quietStart: 22, quietEnd: 7, tz: "Africa/Lagos" };
  assert.equal(inQuietHours(matcher, new Date("2026-01-01T21:00:00Z")), true);
  assert.equal(inQuietHours(matcher, new Date("2026-01-01T12:00:00Z")), false);
});

test("membership statuses accept only actual membership", () => {
  assert.equal(isMemberStatus({ status: "member" }), true);
  assert.equal(isMemberStatus({ status: "administrator" }), true);
  assert.equal(isMemberStatus({ status: "creator" }), true);
  assert.equal(isMemberStatus({ status: "restricted", is_member: true }), true);
  assert.equal(
    isMemberStatus({ status: "restricted", is_member: false }),
    false,
  );
  assert.equal(isMemberStatus({ status: "left" }), false);
  assert.equal(isMemberStatus({ status: "kicked" }), false);
});

test("membership helper works with member, left, and error APIs", async () => {
  assert.equal(
    await fetchMembership(
      { getChatMember: async () => ({ status: "member" }) },
      1,
      2,
    ),
    true,
  );
  assert.equal(
    await fetchMembership(
      { getChatMember: async () => ({ status: "left" }) },
      1,
      2,
    ),
    false,
  );
  await assert.rejects(
    () =>
      fetchMembership(
        {
          getChatMember: async () => {
            throw new Error("network");
          },
        },
        1,
        2,
      ),
    /network/,
  );
});

test("preview and duplicate key normalization are deterministic", () => {
  assert.equal(truncatePreview("abcdef", 3), "abc…");
  assert.equal(duplicateAlertKey(1, -2, 3), "1:-2:3");
  assert.equal(duplicateAlertKey(1, -2, null), null);
});

test("privacy text is tied to storage constants", () => {
  const privacy = buildPrivacyText();
  assert.match(privacy, new RegExp(`${ALERT_RETENTION_DAYS} days`));
  assert.match(privacy, new RegExp(`${ALERT_PREVIEW_LEN} characters`));
  assert.match(privacy, new RegExp(`${MAX_ALERTS_PER_USER} alerts`));
});
