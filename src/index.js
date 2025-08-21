import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  Events
} from "discord.js";
import OpenAI from "openai";

// ---------- Config (env-driven) ----------
const REPLY_CHANCE = Number(process.env.REPLY_CHANCE) || 0.30;
const REPLY_CHANCE_QUESTION = Number(process.env.REPLY_CHANCE_QUESTION) || 0.85;
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES) || 30;
const STARTER_COOLDOWN_MINUTES = Number(process.env.STARTER_COOLDOWN_MINUTES) || 45;

const LANGUAGE = process.env.LANGUAGE || "en-GB";            // UK English
const TIMEZONE = process.env.TIMEZONE || "Europe/London";     // GMT/BST
if (!process.env.TZ) process.env.TZ = TIMEZONE;               // make Node use UK time

const MODEL = process.env.MODEL || "deepseek/deepseek-r1:free";
const FALLBACK_MODEL = process.env.MODEL_FALLBACK || "openrouter/auto"; // set your preferred fallback

const allowlist = (process.env.CHANNEL_NAME_ALLOWLIST || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const allowlistSet = new Set(allowlist);

// ---------- Utilities ----------
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
    return perms?.has(["ViewChannel","SendMessages","ReadMessageHistory"]);
  } catch { return false; }
}

const meta = new Map(); // channelId -> { lastMessageTs, lastStarterTs }
const lastReplies = new Map(); // channelId -> last bot message (to avoid repeating)
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

// ---------- Positive, upbeat starters (with seasonal/weekly rotation) ----------
function cheekyStarter(channelName) {
  const base = [
    `Hey #${channelName}, quick vibe check — what’s one good thing that happened today? ✨`,
    `Alright team, share a tiny win from this week — big or small, it counts! 🙌`,
    `Tea break chat: what are you sipping right now and why is it elite? ☕️`,
    `If you could add one feature to our project today, what would it be (dream big)? 💡`,
    `Two-minute poll: morning person or night owl — what makes it work for you? 🌅🦉`,
    `Shout-out time: who deserves a mini high-five and for what? 👏`,
    `Drop a GIF that matches your current mood — no overthinking. 🎬`,
    `What’s one thing you’re curious about this week? Let’s nerd out together. 🔍`,
    `Your soundtrack right now: song/artist? I’m hunting for new tunes. 🎧`,
    `Pick one: tea dunkers vs non-dunkers — sell me your case in 10 words. 😄`
  ];

  const month = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, month: "numeric" }).format(new Date()));
  let seasonal = [];
  if ([12,1,2].includes(month)) {
    seasonal = [
      `Winter warmers: what’s your go-to cosy drink or snack? ❄️`,
      `What’s one thing you’re aiming to learn before spring? 🌱`
    ];
  } else if ([3,4,5].includes(month)) {
    seasonal = [
      `Spring energy: what fresh start are you making this month? 🌼`,
      `What tiny habit is giving you big results lately? ✨`
    ];
  } else if ([6,7,8].includes(month)) {
    seasonal = [
      `Summer picks: iced coffee or classic brew — and why? 🧊☕`,
      `Holiday mode on or off — what’s your next mini escape? 🏖️`
    ];
  } else {
    seasonal = [
      `Autumn vibes: what’s your comfort watch/read right now? 🍂`,
      `What’s one small goal you want to close out strong this month? ✅`
    ];
  }

  const all = [...base, ...seasonal];
  const weekIndex = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return all[weekIndex % all.length];
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
      if (!canSendInChannel(ch)) continue;
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

// ---------- OpenAI client ----------
const aiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "",
  baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1"
});

// Robust AI call with retry + fallback
async function modelCall(model, prompt) {
  return aiClient.chat.completions.create({
    model,
    temperature: 0.75,
    max_tokens: 500, // plenty of headroom; we still ask for short replies
    messages: [
      {
        role: "system",
        content: `You are "CheekyBuddy", a friendly, funny, cheeky (but kind) Discord pal.
- Use UK English.
- Assume timezone Europe/London (UK). Handle daylight savings (GMT/BST) automatically.
- Current UK date/time is: ${nowUK()} (DD/MM/YYYY HH:mm). If asked "what time is it", use exactly this value.
- Use UK date/time formats (DD/MM/YYYY, 24-hour clock).
- Keep replies under ~90 words. No @here/@everyone. Finish with a complete sentence.`
      },
      { role: "user", content: prompt || "Say hi in a fun cheeky way." },
      { role: "system", content: `Language: ${LANGUAGE}. Be concise, inclusive, SFW.` }
    ]
  });
}

async function aiReply(prompt) {
  // Try primary model
  try {
    const res = await modelCall(MODEL, prompt);
    let out = res?.choices?.[0]?.message?.content?.trim() || "";
    if (out && !/[.!?]$/.test(out)) out += ".";
    if (out) return out;
  } catch (e) {
    console.warn("[AI] Primary model failed:", e?.status || e?.code || e?.message);
    // small backoff for rate limits
    if (e?.status === 429 || e?.code === "insufficient_quota") {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  // Try fallback model
  try {
    const res2 = await modelCall(FALLBACK_MODEL, prompt);
    let out2 = res2?.choices?.[0]?.message?.content?.trim() || "";
    if (out2 && !/[.!?]$/.test(out2)) out2 += ".";
    if (out2) return out2;
  } catch (e2) {
    console.warn("[AI] Fallback model failed:", e2?.status || e2?.code || e2?.message);
  }

  return ""; // caller will do a smart deterministic fallback
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
          const prompt = `Create ONE short, upbeat, welcoming opener for #${ch.name} (max 45 words).
Tone: positive, inclusive, playful.
Avoid words like quiet, dead, crickets, ghost town, or calling people out.
End with a friendly question that invites anyone to jump in.`;

          const ai = await aiReply(prompt);
          const text = (ai || cheekyStarter(ch.name)).trim();

          // avoid repeating exactly the same line back-to-back
          if (lastReplies.get(ch.id) === text) return;

          await ch.send({ content: text, allowedMentions: { parse: [] } });
          lastReplies.set(ch.id, text);
          markStarter(ch.id);
        } catch (e) {
          console.warn("starter failed for channel", ch.id, e?.message || e);
        }
      }
    }
  }
}

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const [, guild] of client.guilds.cache) {
    const list = guild.channels.cache
      .filter(allowedChannel)
      .map(ch => `#${ch.name} (${ch.id})`)
      .join(", ");
    console.log(`[ALLOWED in ${guild.name}]`, list || "(none)");
  }
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

    // Retrieve project snippets if it's a question
    let kbBlock = "";
    if (KB.length && isQuestion(content)) {
      const snips = retrieveSnippets(content, 6);
      if (snips) {
        kbBlock = `\n\nPROJECT NOTES (from Discord):\n${snips}\n\nAnswer ONLY using the notes above. If the answer isn't in the notes, say you don't have that info yet.`;
      }
    }

    const prompt = `Channel: #${message.channel.name}. Be casual, witty, and kind.
User said: ${content.slice(0, 800)}${kbBlock}`;

    let out = await aiReply(prompt);

    // Smart deterministic fallback if AI returns empty
    if (!out) {
      if (KB.length && isQuestion(content)) {
        const snip = retrieveSnippets(content, 1);
        if (snip) {
          out = `From the project notes:\n${snip}\n\nIf you need more detail, check the pinned links and #official-links.`;
        }
      }
      if (!out) out = "I’m having a moment — try that again and I’ll give you a proper answer.";
    }

    // avoid repeating the same reply back-to-back
    if (lastReplies.get(message.channelId) === out) {
      out += " (and yes, I did read that twice!)";
    }

    await message.channel.send({ content: out, allowedMentions: { parse: [] } });
    lastReplies.set(message.channelId, out);
  } catch (e) {
    console.error("on message error:", e?.message || e);
  }
});

client.login(process.env.DISCORD_TOKEN);
