import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  Events
} from "discord.js";
import OpenAI from "openai";

// ---------- Config ----------
const REPLY_CHANCE = Number(process.env.REPLY_CHANCE) || 0.30;
const REPLY_CHANCE_QUESTION = Number(process.env.REPLY_CHANCE_QUESTION) || 0.85;
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES) || 30;
const STARTER_COOLDOWN_MINUTES = Number(process.env.STARTER_COOLDOWN_MINUTES) || 45;

// UK language & timezone
const LANGUAGE = process.env.LANGUAGE || "en-GB";
const TIMEZONE = process.env.TIMEZONE || "Europe/London";
if (!process.env.TZ) process.env.TZ = TIMEZONE; // ensure Node uses UK time

// Webhook: manual (server-owned) URL to avoid App badge
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_CHANNEL_NAME = (process.env.WEBHOOK_CHANNEL_NAME || "bot-test").toLowerCase();

const ukDate = (ts) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(ts));
const nowUK = () => ukDate(Date.now());

const allowlist = (process.env.CHANNEL_NAME_ALLOWLIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const allowlistSet = new Set(allowlist);

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ---------- OpenAI-compatible client ----------
const aiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "",
  baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1"
});
const MODEL = process.env.MODEL || "deepseek/deepseek-r1:free";

// ---------- Helpers ----------
function allowedChannel(ch) {
  if (!ch) return false;
  if (ch.type !== ChannelType.GuildText) return false;
  if (ch.nsfw) return false;
  if (allowlistSet.size && !allowlistSet.has(ch.name.toLowerCase())) return false;
  return true;
}
function canSendInChannel(ch) {
  try {
    const me = ch.guild?.members?.me;
    const perms = ch.permissionsFor(me);
    return perms?.has(["ViewChannel", "SendMessages", "ReadMessageHistory"]);
  } catch { return false; }
}

const meta = new Map(); // channelId -> { lastMessageTs, lastStarterTs }
function markMessage(cid) {
  const m = meta.get(cid) || {};
  m.lastMessageTs = Date.now();
  meta.set(cid, m);
}
function markStarter(cid) {
  const m = meta.get(cid) || {};
  m.lastStarterTs = Date.now();
  meta.set(cid, m);
}
function isQuestion(text) {
  return /\?$/.test(text) || /\b(why|how|what|where|who|when)\b/i.test(text);
}
function cheekyStarter(channelName) {
  const picks = [
    `Right, it's gone suspiciously quiet in #${channelName}… what's everyone up to today?`,
    `Tea or coffee — and why? ☕️`,
    `Tiny wins check: what's one small thing that made your week better?`,
    `If you could add one emoji to the keyboard, what would it be?`,
    `Confession time: what's your mildly controversial food take?`
  ];
  return picks[Math.floor(Math.random() * picks.length)];
}

// ---------- Knowledge Base (reads Discord channels you specify) ----------
const KB = []; // {channelId, channelName, id, author, content, ts}

function tokens(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[`*_~>#[\]()|\\]/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}
function scoreDoc(qTokens, doc) {
  const dTokens = tokens(doc.content);
  if (!dTokens.length) return 0;
  let overlap = 0;
  const set = new Set(dTokens);
  for (const t of qTokens) if (set.has(t)) overlap++;
  return overlap + (/\?/.test(doc.content) ? 0.2 : 0);
}
async function fetchHistory(ch, max = 800) {
  const out = [];
  let before;
  while (out.length < max) {
    const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    for (const [, m] of batch) {
      if (!m.content) continue;
      out.push({
        channelId: ch.id,
        channelName: ch.name,
        id: m.id,
        author: m.author?.bot ? "bot" : (m.author?.username || "user"),
        content: m.content.slice(0, 2000),
        ts: m.createdTimestamp
      });
    }
    before = batch.last()?.id;
    if (!before) break;
  }
  return out;
}
async function buildKnowledgeBase(client) {
  KB.length = 0;
  const names = (process.env.KNOWLEDGE_CHANNELS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) {
    console.log("[KB] No KNOWLEDGE_CHANNELS set — skipping build");
    return;
  }
  let budget = Number(process.env.KNOWLEDGE_MAX_MESSAGES) || 1500;
  for (const [, guild] of client.guilds.cache) {
    for (const [, ch] of guild.channels.cache) {
      if (ch.type !== ChannelType.GuildText) continue;
      if (!names.includes(ch.name.toLowerCase())) continue;
      if (!canSendInChannel(ch)) continue; // ensures bot can view/read
      try {
        console.log(`[KB] Fetching from #${ch.name}…`);
        const take = Math.min(800, budget);
        const msgs = await fetchHistory(ch, take);
        KB.push(...msgs);
        budget -= msgs.length;
        if (budget <= 0) break;
      } catch (e) {
        console.warn("[KB] failed on", ch.name, e?.message || e);
      }
    }
  }
  KB.sort((a, b) => b.ts - a.ts);
  console.log(`[KB] Loaded ${KB.length} messages`);
}
function retrieveSnippets(question, k = 6) {
  const qTokens = tokens(question);
  const scored = KB
    .map(d => ({ d, s: scoreDoc(qTokens, d) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(x => x.d);
  return scored
    .map(d => `[#${d.channelName}] ${ukDate(d.ts)} — ${d.content}`)
    .join("\n\n");
}

// ---------- AI reply ----------
async function aiReply(prompt) {
  try {
    const sys = `You are "CheekyBuddy", a friendly, funny, cheeky (but kind) Discord pal.
- Use UK English.
- Assume timezone Europe/London (UK). Handle daylight savings (GMT/BST) automatically.
- Current UK date/time is: ${nowUK()} (DD/MM/YYYY HH:mm). If asked "what time is it", use exactly this value.
- Use UK formats for dates/times: DD/MM/YYYY and 24-hour clock (e.g., 17:30).
- Never say you're an AI. Keep it light, inclusive, and SFW.
- Avoid @here/@everyone. Keep replies under ~90 words.
- End your response with a complete sentence.`;

    const res = await aiClient.chat.completions.create({
      model: MODEL,
      temperature: 0.75,
      max_tokens: 400,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt || "Say hi in a fun cheeky way." },
        { role: "system", content: `Keep replies concise. Language: ${LANGUAGE}.` }
      ]
    });

    let out = res.choices?.[0]?.message?.content?.trim() || "";
    if (out && !/[.!?]$/.test(out)) out += ".";
    return out;
  } catch (e) {
    console.error("AI error:", e?.status || e?.code || e?.message);
    return "";
  }
}

// ---------- Webhook sending (manual URL ONLY; no fallback except on HTTP failure) ----------
async function sendViaWebhook(channel, content) {
  const url = WEBHOOK_URL;
  if (!url) {
    console.warn("[WEBHOOK] WEBHOOK_URL missing — cannot send via webhook.");
    return channel.send({ content, allowedMentions: { parse: [] } }); // will show App
  }

  try {
    console.log(`[WEBHOOK] FORCED manual webhook POST (ignoring channel), target UI name: ${WEBHOOK_CHANNEL_NAME}`);
    // Use the webhook’s configured name/avatar (set in Integrations UI).
    // Do NOT override username/avatar_url here; we want it purely server-owned visually.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] }
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[WEBHOOK] HTTP ${res.status}: ${txt}`);
    }
    return;
  } catch (e) {
    console.warn("[WEBHOOK] send error:", e?.message || e);
    // Only if webhook POST fails completely, use normal send (shows App)
    return channel.send({ content, allowedMentions: { parse: [] } });
  }
}

// ---------- Idle starter ----------
async function idleSweep() {
  const now = Date.now();
  const idleMs = IDLE_MINUTES * 60 * 1000;
  const cooldownMs = STARTER_COOLDOWN_MINUTES * 60 * 1000;

  for (const [, guild] of client.guilds.cache) {
    const channels = guild.channels.cache.filter(allowedChannel);
    for (const [, ch] of channels) {
      if (!canSendInChannel(ch)) continue;
      const m = meta.get(ch.id) || {};
      const lastMsg = m.lastMessageTs || 0;
      const lastStarter = m.lastStarterTs || 0;
      const idle = (now - lastMsg) > idleMs;
      const cooled = (now - lastStarter) > cooldownMs;

      if (idle && cooled) {
        try {
          await ch.sendTyping();
          const prompt = `No one has chatted for a while in #${ch.name}. Create ONE short cheeky opener under 45 words and end with a question.`;
          const ai = await aiReply(prompt);
          const text = (ai || cheekyStarter(ch.name)).trim();
          await sendViaWebhook(ch, text);
          markStarter(ch.id);
        } catch (e) {
          console.warn("starter failed for channel", ch.id, e?.message || e);
        }
      }
    }
  }
}

// ---------- Events ----------
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const [, guild] of client.guilds.cache) {
    const list = guild.channels.cache
      .filter(allowedChannel)
      .map(ch => `#${ch.name} (${ch.id})`)
      .join(", ");
    console.log(`[ALLOWED in ${guild.name}]`, list || "(none)");
  }

  // One-time webhook startup check (should appear in your channel with NO App badge)
  (async () => {
    try {
      if (WEBHOOK_URL) {
        console.log("[WEBHOOK] Sending startup check via MANUAL webhook URL");
        await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "✅ Webhook startup check: if you see this with NO App badge, you’re good.",
            allowed_mentions: { parse: [] }
          })
        });
      } else {
        console.warn("[WEBHOOK] No WEBHOOK_URL set; cannot run startup check.");
      }
    } catch (e) {
      console.warn("[WEBHOOK] Startup check failed:", e?.message || e);
    }
  })();

  setInterval(idleSweep, 60 * 1000).unref();
  buildKnowledgeBase(client).catch(e => console.error("[KB] build error", e));
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!allowedChannel(message.channel)) return;
    if (!canSendInChannel(message.channel)) {
      console.warn("[SKIP] missing perms in channel:", message.channel?.name);
      return;
    }

    markMessage(message.channelId);

    const content = (message.content || "").trim();
    const mentioned = message.mentions.has(client.user);
    const chance = isQuestion(content) ? REPLY_CHANCE_QUESTION : REPLY_CHANCE;

    // Always reply if directly mentioned; otherwise probabilistic
    if (!mentioned && Math.random() > chance) return;

    await message.channel.sendTyping();

    // Pull project snippets if it's a question
    let kbBlock = "";
    if (KB.length && isQuestion(content)) {
      const snips = retrieveSnippets(content, 6);
      if (snips) {
        kbBlock = `\n\nPROJECT NOTES (from Discord):\n${snips}\n\nAnswer ONLY using the notes above. If the answer isn't in the notes, say you don't have that info yet.`;
      }
    }

    const prompt = `Channel: #${message.channel.name}. Be casual, witty, and kind.\nUser said: ${content.slice(0, 800)}${kbBlock}`;
    let out = await aiReply(prompt);
    if (!out) out = "my brain just buffered 🤖💭—say that again?";

    await sendViaWebhook(message.channel, out);
  } catch (e) {
    console.error("on message error:", e?.message || e);
  }
});

client.login(process.env.DISCORD_TOKEN);
