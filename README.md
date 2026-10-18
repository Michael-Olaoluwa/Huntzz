# Huntzz

A Telegram bot that **privately alerts members when a message they care about is
posted** in a group or channel. Members pick keywords per group; when a message
matches, Huntzz sends them a direct message with a preview and a link back to the
original post.

- Runs on **long polling** (no public web server or webhook needed).
- Single file: `bot.js` (Node.js ESM, [grammY](https://grammy.dev), Supabase).
- Storage: **Supabase** (Postgres). Users, groups, subscriptions, keywords and
   matched-message previews are stored for the inbox.

---

## How it works

1. An admin adds Huntzz to a group or channel. It registers the chat and gives
   group admins an option to post a short introduction.
2. Members open the bot in private, tap **My groups**, and subscribe to the chats
   they want to follow (membership is verified with `getChatMember`).
3. Members add **keywords** per group (up to 20 each; up to 50 subscriptions each).
4. When a message is posted, Huntzz matches it against subscribers' keywords
   (whole-word/phrase, case-insensitive) and DMs each matching member once, listing
   every keyword that matched, with an "Open message" link.

Unsubscribing keeps your keywords, so re-subscribing is instant. Matching always
respects the subscription being active.

---

## Setup

### 1. Create the bot

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **token**.
2. Still in BotFather: `/setprivacy` → choose your bot → **Disable**. This is
   required so the bot can see normal group messages. If the bot is already in a
   group, remove and re-add it after changing this.
   - In channels, add the bot as an **administrator** so it can read posts.

### 2. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query** and set up the database. You have two
   equivalent paths:
   - **Simplest:** run `schema.sql` once. It is the complete current schema
   (version 6) and is safe on any database — fresh _or_ pre-existing. On an
     older database it adds the missing columns and fixes the foreign keys; on a
     fresh one it just builds everything.
   - **Incremental:** on an existing database, run the migrations in numeric
     order, once: `001_lock_down_rls.sql` → `002_chat_matchers.sql` →
   `003_pending_input.sql` → `004_upgrade.sql` → `005_stage5.sql` → `006_migrate_chat_merge.sql`.
   - Migrations must be run in order and **once**. `002` and `003` are **not**
     re-runnable after `004` (004 replaces `chat_matchers` with a new return type,
     and `CREATE OR REPLACE` cannot change a function's return type). `004` and
     `schema.sql` are both safe to re-run.
3. In **Settings → API**, copy:
   - Project URL → `SUPABASE_URL`
   - **service_role** key → `SUPABASE_KEY` (server-side only — never expose it)

### 3. Configure environment

Copy `.env.example` to `.env` and fill it in:

| Variable         | Required | Description                                               |
| ---------------- | -------- | --------------------------------------------------------- |
| `BOT_TOKEN`      | yes      | Token from BotFather                                      |
| `SUPABASE_URL`   | yes      | `https://<project>.supabase.co`                           |
| `SUPABASE_KEY`   | yes      | Supabase **service_role** key                             |
| `DEBUG`          | no       | `true` logs message text to the console (default `false`) |
| `AD_FILTER_MODE` | no       | `off`, `log` (default) or `drop` — see Ad filter below    |
| `GROUP_NOTICE_MODE` | no    | `off`, `button` (default) or `auto` for group introductions |
| `OWNER_ID`       | no       | Owner Telegram user id; enables owner-only `/stats`; unset or invalid disables it |

`.env` is gitignored. Never commit it.

### 4. Run locally

```bash
npm install
npm start        # or: node bot.js
```

Node.js **20 or newer** is required.

---

## Commands

| Command           | Where   | What it does                                                 |
| ----------------- | ------- | ------------------------------------------------------------ |
| `/start`          | private | Main menu (Add to group, My groups, Keywords, Help, Privacy) |
| `/help`           | private | What Huntzz does + how to never miss an alert                |
| `/privacy`        | private | Plain-language data handling                                 |
| `/keywords`       | private | Add/remove keywords per subscribed group                     |
| `/unsubscribeall` | private | Stop following every group (keywords are kept)               |
| `/pause [hours]`  | private | Pause alerts for up to 30 days                               |
| `/resume`         | private | Resume paused alerts                                         |
| `/quiet HH HH`    | private | Set quiet hours, including overnight windows                 |
| `/quietoff`       | private | Clear quiet hours                                            |
| `/deleteme`       | private | Permanently delete your account data                         |
| `/stats`          | owner   | Show recent alert and usage counters                         |
| `/cancel`         | private | Cancel a pending keyword entry                               |

---

## Ad filter

Huntzz can ignore obvious spam before alerting. Patterns live in one clearly
marked block near the top of `bot.js` (search for `Ad filter patterns (Stage 4)`).

`AD_FILTER_MODE`:

- `off` — no filtering.
- `log` — **(default)** never drops anything; logs suspected ads only when `DEBUG=true`.
- `drop` — skips alerts for suspected ads, **except** when the sender is an admin of
  that group (channel posts always count as admin). Admin lists are cached 10 min.

---

## Deploying

No web port is needed — Huntzz uses long polling, so deploy it as a **long-running
worker process**.

### Railway

1. New Project → Deploy from GitHub (this repo).
2. Add the three variables (`BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY`; optionally
   `DEBUG`, `AD_FILTER_MODE`).
3. Railway runs `npm start` (from `package.json`). Ensure there is exactly one
   instance, since two pollers would conflict.

### Render

1. New → **Background Worker** (not a Web Service).
2. Build command: `npm install` · Start command: `npm start`.
3. Add the same environment variables.
4. Avoid free tiers that **sleep/spin down** — a sleeping bot misses updates and
   long polling stops. Use a paid/always-on instance.

> Only run **one** instance of the bot at a time. Two pollers on the same token
> will fight over updates.

---

## Project layout

```
bot.js                        # the whole bot
schema.sql                    # complete current schema (version 6) — fresh installs run this
migrations/
  001_lock_down_rls.sql       # RLS on, all permissive policies dropped
  002_chat_matchers.sql       # single-query matcher RPC (superseded by 004)
  003_pending_input.sql       # pending_input table, users.blocked, subscriptions.active
  004_upgrade.sql             # pause/quiet/tz, alert_admins, alerts inbox, stats,
                              # FK cascade rules, migrate_chat, new chat_matchers, inbox RPCs
   005_stage5.sql              # duplicate alert protection
   006_migrate_chat_merge.sql  # safe chat merges and notice state
.env.example                  # template for .env
```

## Security notes

- RLS is enabled on every table with **no policies**; only the `service_role` key
  (which bypasses RLS) can read/write. Verify by running a `select` as the `anon`
  role — it returns nothing.
- For matched messages, the bot stores a preview up to 200 characters, group name,
   available link and matched keywords for 7 days, capped at 500 alerts per user.
   Nothing is stored for messages that match nobody, and no media is stored.
- With `DEBUG=false` (default), message text is never written to server logs.
