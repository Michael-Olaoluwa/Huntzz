# Huntzz

A Telegram bot that **privately alerts members when a message they care about is
posted** in a group or channel. Members pick keywords per group; when a message
matches, Huntzz sends them a direct message with a preview and a link back to the
original post.

- Runs on **long polling** (no public web server or webhook needed).
- Single file: `bot.js` (Node.js ESM, [grammY](https://grammy.dev), Supabase).
- Storage: **Supabase** (Postgres). Users, groups, subscriptions and keywords are
  stored; **message text is never stored**.

---

## How it works

1. An admin adds Huntzz to a group or channel. It registers the chat and posts a
   short notice.
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
2. Open **SQL Editor → New query** and run, in this order:
   1. `schema.sql`
   2. `migrations/001_lock_down_rls.sql`
   3. `migrations/002_chat_matchers.sql`
   4. `migrations/003_pending_input.sql`
3. In **Settings → API**, copy:
   - Project URL → `SUPABASE_URL`
   - **service_role** key → `SUPABASE_KEY` (server-side only — never expose it)

### 3. Configure environment

Copy `.env.example` to `.env` and fill it in:

| Variable         | Required | Description                                                        |
| ---------------- | -------- | ------------------------------------------------------------------ |
| `BOT_TOKEN`      | yes      | Token from BotFather                                               |
| `SUPABASE_URL`   | yes      | `https://<project>.supabase.co`                                    |
| `SUPABASE_KEY`   | yes      | Supabase **service_role** key                                      |
| `DEBUG`          | no       | `true` logs message text to the console (default `false`)          |
| `AD_FILTER_MODE` | no       | `off`, `log` (default) or `drop` — see Ad filter below             |

`.env` is gitignored. Never commit it.

### 4. Run locally

```bash
npm install
npm start        # or: node bot.js
```

Node.js **20 or newer** is required.

---

## Commands

| Command            | Where   | What it does                                     |
| ------------------ | ------- | ------------------------------------------------ |
| `/start`           | private | Main menu (Add to group, My groups, Keywords, Help, Privacy) |
| `/help`            | private | What Huntzz does + how to never miss an alert    |
| `/privacy`         | private | Plain-language data handling                     |
| `/keywords`        | private | Add/remove keywords per subscribed group         |
| `/unsubscribeall`  | private | Stop following every group (keywords are kept)   |
| `/cancel`          | private | Cancel a pending keyword entry                   |

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
schema.sql                    # base tables (run first)
migrations/
  001_lock_down_rls.sql       # RLS on, all permissive policies dropped
  002_chat_matchers.sql       # single-query matcher RPC
  003_pending_input.sql       # pending_input table, users.blocked, subscriptions.active
.env.example                  # template for .env
```

## Security notes

- RLS is enabled on every table with **no policies**; only the `service_role` key
  (which bypasses RLS) can read/write. Verify by running a `select` as the `anon`
  role — it returns nothing.
- The bot stores no message text. With `DEBUG=false` (default), message text is
  never logged either.
