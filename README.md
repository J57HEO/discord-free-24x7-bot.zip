# CheekyBuddy — Free 24/7 Discord Chat Bot (OpenRouter + Koyeb)

This bot replies to ~30% of messages in **#general-chat**, is **funny + cheeky (but kind)**, and **starts a convo** if the channel is quiet for **30 minutes**.

It runs **for free** by:
- Using **OpenRouter** free model routes (e.g., `deepseek/deepseek-r1:free`).
- Hosting on **Koyeb**'s free instance (always-on tiny container).

> ⚠️ Free tiers can change. As of Aug 2025, Koyeb provides a free instance and OpenRouter lists free models. If limits change, you may need to switch models/providers or upgrade.

---

## 0) What you need
- A Discord server where you’re an Admin.
- A GitHub account.
- A Koyeb account.
- An OpenRouter account (free) to get an API key.

---

## 1) Create your Discord bot (Developer Portal)

1. Go to https://discord.com/developers/applications → **New Application** → name it → **Create**.
2. Left menu **Bot** → **Add Bot** → confirm.
3. On **Bot** page:
   - **Privileged Gateway Intents** → toggle **Message Content Intent** **ON** → **Save**.
   - Click **Reset Token** → **Copy** the token.
4. Invite it to your server:
   - Left menu **OAuth2 → URL Generator**:
     - **Scopes**: `bot`
     - **Bot Permissions**: `View Channels`, `Send Messages`, `Read Message History`
   - Copy the URL → open it → pick your server → **Authorize**.

---

## 2) Put the code on GitHub (no terminal)

1. Go to https://github.com → **New repository** → call it `discord-free-24x7-bot` → **Create**.
2. On the empty repo page: **Add file → Upload files**.
3. On your computer, open the **unzipped project folder** and **select everything inside it** (all files and the `src` folder). **Do NOT include `node_modules`.**
4. Drag/drop into GitHub. Scroll down → **Commit changes**.
5. Confirm the repo shows `package.json`, `src/`, `config.json`, `.gitignore` at the **top level**.

---

## 3) Get a free AI API key (OpenRouter)

1. Go to https://openrouter.ai → sign up.
2. Open **Dashboard → API Keys** → **Create Key** → copy it.
3. Keep handy: **Base URL** = `https://openrouter.ai/api/v1` and model name **`deepseek/deepseek-r1:free`**.

---

## 4) Host it FREE on Koyeb (always on)

1. Go to https://www.koyeb.com → sign in.
2. **Create Service** → **Deploy from GitHub** → select your repo.
3. **Runtime**: Keep default (Koyeb detects Node automatically).
4. **Environment Variables** → add these exact keys (no quotes):
   - `DISCORD_TOKEN` = *(paste from Step 1)*
   - `OPENAI_API_KEY` = *(paste your OpenRouter key)*
   - `OPENAI_BASE_URL` = `https://openrouter.ai/api/v1`
   - `MODEL` = `deepseek/deepseek-r1:free`
   - `CHANNEL_NAME_ALLOWLIST` = `general-chat`
   - `NODE_VERSION` = `18`
5. **Build & Run**:
   - **Start command**: `npm start`
6. Click **Deploy**.
7. Open **Logs**. Success looks like: `Logged in as CheekyBuddy#1234`.

> If you ever see “CRASHED”: check variables, make sure `npm start` is set, confirm `package.json` is at repo root.

---

## 5) Give the bot permission in #general-chat

In your server:
- Right-click **#general-chat** → **Edit Channel → Permissions** → add the bot (or its role).
- Allow: **View Channel**, **Send Messages**, **Read Message History**.
- If the channel is inside a private **category**, set the same on the **category**.

---

## 6) Test it
- Say “hi” in **#general-chat** (or mention the bot once). It should reply naturally.
- Leave the channel idle 30 minutes → it posts a cheeky opener.

---

## Troubleshooting (fast)
- **No logs / build failed on Koyeb** → Ensure repo root shows `package.json`, `src/`; **Start command** = `npm start`; add `NODE_VERSION=18`; **Redeploy**.
- **Bot online but silent** → Enable **Message Content Intent** (Step 1), check channel permissions, and ensure channel name matches `CHANNEL_NAME_ALLOWLIST`.
- **Shows typing but nothing posts** → Missing *Send Messages* permission or rate-limited model. The bot falls back to a safe message if the AI returns empty.
- **API errors / 429** → Free model is throttled. Switch to another free model on OpenRouter or add a small paid key.

---

## Change personality or channels
- Edit **`config.json`** for reply rates or idle minutes.
- Edit **`src/prompt.js`** to tweak the voice.
- Set `CHANNEL_NAME_ALLOWLIST` env to a comma-separated list, e.g. `general-chat,banter`.

---

### That’s it. Your bot is free, cheeky, and runs 24/7 on Koyeb.
