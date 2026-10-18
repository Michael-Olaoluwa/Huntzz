# Huntzz - Current Behavior

This document describes the behavior implemented by the current repository. Claims
that depend on Telegram or the live Supabase project are marked **UNVERIFIED**.

## Overview

Huntzz is a Telegram bot for following messages in registered groups and channels.
A user follows a chat, chooses keywords, and receives a private alert when a new
message matches. The bot runs as one long-polling Node.js process. It does not use
a webhook or HTTP server.

The runtime is in `bot.js`. Pure helpers are in `lib.js`. Data is stored in
Supabase PostgreSQL using the server-side `service_role` key. RLS is enabled on the
application tables and the schema intentionally has no public policies.

The bot stores user and chat metadata, subscriptions, keywords, pending input, and
inbox rows. For a matching message, an inbox row stores a preview up to 200
characters, group name, available link, matched keywords, read state, and timestamps
for seven days. No media is stored. A message that matches nobody produces no inbox
row.

## Setup And Configuration

Required environment variables:

- `BOT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_KEY` containing the server-side service-role key

Optional variables:

- `DEBUG=false`: when `true`, group/channel message text may be written to logs.
- `AD_FILTER_MODE=log`: `off`, `log`, or `drop`.
- `GROUP_NOTICE_MODE=button`: `off`, `button`, or `auto`.
- `OWNER_ID`: the owner's numeric Telegram user id. Invalid or unset values disable
  `/stats` for everyone.

Node.js 20 or newer is required. The visible command menu is registered at startup.
Only one poller should run for a bot token. Whether deployment has exactly one
poller is **UNVERIFIED**.

The database can be installed from `schema.sql`, which represents version 6, or by
running migrations 001 through 006 in order. Whether those migrations have been
applied to the live database is **UNVERIFIED**.

## Database Versions

- `001_lock_down_rls.sql`: enables RLS on the original tables and drops their
  policies.
- `002_chat_matchers.sql`: creates the original keyword-row matcher RPC.
- `003_pending_input.sql`: adds persistent pending input, blocked users, soft
  subscriptions, and matcher filtering for active/non-blocked users.
- `004_upgrade.sql`: adds pause/quiet settings, time zone, setup sound state,
  admin-post subscriptions, alerts, daily stats, inbox RPCs, foreign-key cleanup,
  `migrate_chat`, and the final matcher return shape.
- `005_stage5.sql`: removes older duplicate alerts and adds the unique
  `(user_id, chat_id, message_id)` index for non-null message ids.
- `006_migrate_chat_merge.sql`: adds `groups.notice_posted_at`, replaces
  `migrate_chat` with the v6 merge behavior, and adds the `v6` function comment.

Migrations 002 and 003 must not be rerun after 004 because the matcher return type
changes. Migrations 004, 005, and 006 are idempotent. `schema.sql` is the final
state for fresh installations or a complete rebuild.

## User Flow

### First private interaction

`/start` upserts the user and shows Home. A first-time user also receives the
setup checklist. The checklist tracks:

1. The bot has been added to at least one group or channel.
2. The user follows a group.
3. The user has at least one keyword.
4. Optional notification-sound guidance marked Done or Skip.

The first three steps define setup completion. The fourth is only a reminder.

### Registering a chat

Telegram sends `my_chat_member` when the bot is added. The bot records the chat
id, title, type, adder, and active state. It privately tells the adder that the
chat is ready and provides a follow link.

Registration behavior is controlled by `GROUP_NOTICE_MODE`:

- `off`: no group introduction is posted and no intro button is shown.
- `button` (default): for groups and supergroups, the adder receives a private
  `Post an intro in the group` button.
- `auto`: for a new group or supergroup registration, the intro is posted once
  automatically.

Channels never receive introductions. The intro button is accepted only when the
pressing user is currently a Telegram creator or administrator of that chat. A
successful post sets `groups.notice_posted_at`; later presses report that it was
already posted. Telegram permission failures are caught and do not stop polling.

The current intro text explains keyword alerts, previews up to 200 characters,
seven-day retention, and `/privacy`. It is built from the same constants used by
alert storage.

When the bot is removed or kicked, `groups.active` becomes false. Existing
subscriptions and keywords remain, but matching stops for that chat.

### My Groups and subscriptions

`My groups` loads active registered chats and verifies the current user with
Telegram `getChatMember`. Only chats where the user is currently accepted as a
member are shown. Membership results are cached for ten minutes.

Accepted statuses are `member`, `administrator`, `creator`, and `restricted` only
when `is_member` is true. `left` and `kicked` are not members. API errors fail
closed for display.

Selecting a chat performs the same membership check. A new active subscription is
created, an active subscription is deactivated to unfollow, and an inactive row is
reactivated. There can be at most 50 active subscriptions. Unfollowing keeps
keywords but deletes that user's alerts for the chat and clears relevant caches.

`/groups` is visible in the command menu. `/mygroups` is a hidden alias.

### Keywords

`/keywords` lists active subscriptions whose groups are active. A group keyword
screen lists the user's words, permits deletion, exposes admin-post alerts, and
shows starter packs:

- Jobs: `job`, `vacancy`, `hiring`, `internship`
- Events: `event`, `workshop`, `webinar`, `conference`
- Housing: `rent`, `room`, `apartment`, `house`
- Marketplace: `selling`, `buy`, `price`, `available`

Starter packs preserve existing words and respect the 20-word per-group limit.

Adding a word stores one pending `add_keyword` action for ten minutes. Input is
trimmed, internal whitespace is collapsed, lowercased, and capped at 40 characters.
Punctuation-only input is rejected. Invalid input keeps the pending action so the
user can try again. A command clears pending input. `/cancel` clears it explicitly.

Plain private text without pending input receives a short menu prompt. Keyword rows
are unique per user, chat, and normalized word. The matcher cache is invalidated
when subscriptions or keywords change.

### Pause and quiet hours

`/pause` pauses for 24 hours. `/pause <hours>` accepts 1 through 720 hours.
`/resume` clears the pause.

`/quiet <start> <end>` accepts integer hours from 0 through 23 and supports windows
that cross midnight, such as `/quiet 22 7`. Hours are evaluated in the user's
stored timezone, defaulting to `Africa/Lagos`. `/quietoff` clears the window.

Paused and quiet-hour matches are still stored in the inbox but do not produce a
DM.

### Deletion

`/deleteme` requires confirmation. Confirming deletes the user row. Foreign keys
cascade to that user's subscriptions, keywords, pending input, and alerts. The bot
also clears in-memory caches for that user.

### Owner stats

`/stats` is private and owner-only. It returns nothing to non-owners and when
`OWNER_ID` is unset or invalid. It reports seven-day alert counters plus current
user, active-group, and active-follow counts.

## Matching And Delivery

The bot processes new `message` updates for groups/supergroups and new
`channel_post` updates. Edited messages are not requested. Text or captions are
matched. Empty text and the bot's own messages are ignored.

Keywords use case-insensitive Unicode-aware whole-word/phrase matching. Letters and
numbers on either side prevent a match. Whitespace inside phrases may vary. A user
is never alerted about their own message. One recipient gets one hit containing all
matched keywords.

The ad filter patterns recognize invite links and common subscription/click-link
phrases. `off` never filters. `log` never drops. `drop` suppresses suspected ads
unless the sender is a group administrator; channel posts are treated as admin
posts.

Before an alert is stored or delivered, the recipient's membership is checked.
Up to ten membership requests run concurrently and Telegram's throttler remains
active. A confirmed non-member causes:

- the subscription to become inactive;
- that user's alerts for the chat to be deleted;
- relevant caches to be invalidated; and
- no alert for the current message.

A membership API error fails closed for the current recipient and changes nothing in
the database. The error log contains ids and the API error description, not message
text. Membership results are cached for ten minutes, so a departure can remain
cached as membership for at most that period after the last successful check.

The matcher RPC is cached per chat for 45 seconds. It returns active subscribers
with keyword arrays, admin-post state, pause state, quiet state, and timezone. It
excludes inactive groups, inactive subscriptions, and blocked users.

The alert DM contains the chat title, sender when available, escaped preview,
matched keywords or admin-post label, and an Open message button when a link can be
built. Public chats use `t.me/<username>/<message_id>`. Supergroups and channels
without usernames use `t.me/c/<id>/<message_id>`. Basic groups have no link.

DM sends retry Telegram rate limits and are throttled. Successful sends increment
`alerts_delivered`; failures increment `alerts_failed`. A Telegram 403 marks the
user blocked until a later private interaction clears that state. Duplicate alert
inserts are ignored by the version 5 unique index and increment `alerts_duplicate`.
Stats writes are caught, and an unhandled promise rejection handler logs only a
short operation-independent notice.

## Inbox And Retention

Each stored alert includes:

- recipient user id;
- chat id and title;
- Telegram message id when available;
- up to 200 characters of preview;
- matched keyword array;
- optional link;
- admin-post flag;
- read flag and creation time.

Rows older than seven days are purged at startup and hourly. Each user retains only
the newest 500 rows. The inbox groups rows by keyword hash `ik:<sha1(keyword)[0:10]>`,
provides an admin-post bucket, supports pagination, marks viewed rows read, and can
mark all read or clear the inbox.

Unfollowing a chat deletes that user's rows for the chat. Confirming
`/unsubscribeall` deactivates all follows, preserves keywords, and clears the
user's inbox.

## Privacy Text And Storage

The public privacy text says:

- Huntzz reads only chats where it has been added and only to check member keywords.
- For each match it stores a preview up to 200 characters, group name, available
  link, and matched keywords for seven days so the inbox works.
- At most 500 alerts are stored per user.
- Alerts for a chat are deleted when the user unfollows or leaves it.
- Nothing is stored for messages that match nobody, and no media is stored.
- User ids, group ids, and keywords are stored in a database run by the bot owner.
- Users can clear the inbox or erase everything with `/deleteme`.
- A group admin can remove the bot to stop reading.
- Server logs contain message text only when `DEBUG=true`.

The privacy text is generated from the preview, retention, and inbox-cap constants
so those numbers cannot drift independently from behavior.

## Unverified Operational Items

The repository cannot prove:

- that migrations 001 through 006 have been applied to the live Supabase project;
- that Supabase RLS has the intended live state;
- that the deployed process has the service-role key and correct environment;
- that BotFather privacy mode is disabled;
- that the bot is an administrator in every channel it should read;
- that exactly one polling instance is running;
- that Telegram deep links open for the intended members; or
- that the three-account leave/admin/notice smoke test has been performed live.

These items require the read-only verification SQL and live Telegram checks described
in the deployment kit.
