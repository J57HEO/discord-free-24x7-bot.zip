import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  Events,
  PermissionFlagsBits
} from "discord.js";
import OpenAI from "openai";

// ---------- Config (env-driven) ----------
const REPLY_CHANCE = Number(process.env.REPLY_CHANCE) || 0.30;                 // general chat reply chance
const REPLY_CHANCE_QUESTION = Number(process.env.REPLY_CHANCE_QUESTION) || 0.85; // higher if message looks like a question
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES) || 30;
const STARTER_COOLDOWN_MINUTES = Number(process.env.STARTER_COOLDOWN_MINUTES) || 45;

const LANGUAGE = process.env.LANGUAGE || "en-GB";            // UK English
const TIMEZONE = process.env.TIMEZONE || "Europe/London";     // GMT/BST
if (!process.env.TZ) process.env.TZ = TIMEZONE;               // make Node use UK time

const MODEL = process.env.MODEL || "deepseek/deepseek-r1:free";
const FALLBACK_MODEL = process.env.MODEL_FALLBACK || "openrouter/auto"; // robust fallback

// Tenor (GIFs)
const TENOR_API_KEY = process.env.TENOR_API_KEY || "";

// KB tuning
const KB_MAX_SNIPPETS = Number(process.env.KB_MAX_SNIPPETS) || 6;
const KB_MIN_SCORE = Number(process.env.KB_MIN_SCORE) || 2;            // require at least 2 token overlaps
const KB_RECENCY_BOOST_DAYS = Number(process.env.KB_RECENCY_BOOST_DAYS) || 45;

// Stickers
const STICKER_IDLE_CHANCE = Number(process.env.STICKER_IDLE_CHANCE) || 0.25; // 25% of idle nudges use a sticker
// New: scheduled sticker broadcast
const STICKER_BROADCAST_ENABLED = String(process.env.STICKER_BROADCAST_ENABLED || "true").toLowerCase() === "true";
const STICKER_BROADCAST_INTERVAL_MIN = Number(process.env.STICKER_BROADCAST_INTERVAL_MIN) || 120; // 2 hours
const STICKER_BROADCAST_JITTER_MIN = Number(process.env.STICKER_BROADCAST_JITTER_MIN) || 12; // +/- jitter
const STICKER_BROADCAST_IDLE_GUARD_MIN = Number(process.env.STICKER_BROADCAST_IDLE_GUARD_MIN) || 15; // only drop if channel had no messages for 15 min

// Allowed chat channels
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
    return perms?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory
    ]);
  } catch { return false; }
}
function canReadChannel(ch) {
  // for KB build — only needs view + read history
  try {
    const me = ch.guild?.members?.me;
    const perms = ch.permissionsFor(me);
    return perms?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory
    ]);
  } catch { return false; }
}
function isQuestion(text) {
  return /\?$/.test(text) || /\b(why|how|what|where|who|when|which|can|do|does|did|is|are|will|should)\b/i.test(text);
}
function looksLikeGifRequest(text) {
  const t = text.toLowerCase();
  return (
    /^gif[:\s]/i.test(text) ||
    /\bsend (me )?a gif of\b/i.test(text) ||
    /\bshow (me )?a gif\b/i.test(text) ||
    /\bpost (a )?gif\b/i.test(text)
  );
}
function extractGifQuery(text) {
  const t = text.trim();
  const m1 = t.match(/^gif[:\s]+(.+)/i);
  if (m1) return m1[1].trim();
  const m2 = t.match(/\bsend (me )?a gif of\s+(.+)/i);
  if (m2) return m2[2].trim();
  const m3 = t.match(/\bshow (me )?a gif of\s+(.+)/i);
  if (m3) return m3[2].trim();
  const m4 = t.match(/\b(post|share)\s+(a\s+)?gif\s+(of|about)?\s*(.+)/i);
  if (m4) return (m4[4] || "").trim();
  return t.replace(/^gif[:\s]*/i, "").trim();
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
  if ([12,1,2].includes(month)) seasonal = [
    `Winter warmers: what’s your go-to cosy drink or snack? ❄️`,
    `What’s one thing you’re aiming to learn before spring? 🌱`
  ];
  else if ([3,4,5].includes(month)) seasonal = [
    `Spring energy: what fresh start are you making this month? 🌼`,
    `What tiny habit is giving you big results lately? ✨`
  ];
  else if ([6,7,8].includes(month)) seasonal = [
    `Summer picks: iced coffee or classic brew — and why? 🧊☕`,
    `Holiday mode on or off — what’s your next mini escape? 🏖️`
  ];
  else seasonal = [
    `Autumn vibes: what’s your comfort watch/read right now? 🍂`,
    `What’s one small goal you want to close out strong this month? ✅`
  ];

  const all = [...base, ...seasonal];
  const weekIndex = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return all[weekIndex % all.length];
}

// ---------- Knowledge Base ----------
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

  // recency boost (within last X days)
  const days = (Date.now() - doc.ts) / (24*60*60*1000);
  const recencyBoost = days <= KB_RECENCY_BOOST_DAYS ? 0.5 : 0;

  return overlap + recencyBoost;
}

async function fetchHistory(ch, max = 800) {
  const out = [];
  let before;
  while (out.length < max) {
    const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    for (const [, m] of batch) {
      const clean = (m.content || "").trim();
      if (!clean) continue;
      out.push({
        channelId: ch.id,
        channelName: ch.name,
        id: m.id,
        author: m.author?.bot ? "bot" : (m.author?.username || "user"),
        content: clean.slice(0, 2000),
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
      if (!canReadChannel(ch)) {
        console.warn(`[KB] Missing read perms for #${ch.name} — need View Channel + Read Message History`);
        continue;
      }
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

function retrieveSnippets(question, k = KB_MAX_SNIPPETS) {
  const qTokens = tokens(question);
  const scored = KB
    .map(d => ({ d, s: scoreDoc(qTokens, d) }))
    .filter(x => x.s >= KB_MIN_SCORE)
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
async function modelCall(model, messages) {
  return aiClient.chat.completions.create({
    model,
    temperature: 0.6,     // tighter for accuracy on KB answers
    max_tokens: 500,
    messages
  });
}

async function aiReply(prompt, kbText) {
  const sys = `You are "CheekyBuddy", a friendly, funny, cheeky (but kind) Discord pal.
- Use UK English.
- Timezone: Europe/London (GMT/BST). Current UK date/time: ${nowUK()} (DD/MM/YYYY HH:mm).
- Keep replies under ~90 words. No @here/@everyone. End with a complete sentence.`;

  const grounded = !!kbText;

  const userMsg = grounded
    ? `Answer the user's question ONLY using the PROJECT NOTES below.
If the notes don't contain the answer, say briefly you don't have that info yet and suggest where to look (e.g., #official-links).
Keep it concise, friendly, and clear.

User question:
${prompt}

PROJECT NOTES:
${kbText}`
    : prompt;

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: userMsg },
    { role: "system", content: `Language: ${LANGUAGE}. Be concise, inclusive, SFW. Answer the question directly first, THEN add one cheeky line at most.` }
  ];

  try {
    const res = await modelCall(MODEL, messages);
    let out = res?.choices?.[0]?.message?.content?.trim() || "";
    if (out && !/[.!?]$/.test(out)) out += ".";
    if (out) return out;
  } catch (e) {
    console.warn("[AI] Primary model failed:", e?.status || e?.code || e?.message);
    if (e?.status === 429 || e?.code === "insufficient_quota") {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  try {
    const res2 = await modelCall(FALLBACK_MODEL, messages);
    let out2 = res2?.choices?.[0]?.message?.content?.trim() || "";
    if (out2 && !/[.!?]$/.test(out2)) out2 += ".";
    if (out2) return out2;
  } catch (e2) {
    console.warn("[AI] Fallback model failed:", e2?.status || e2?.code || e2?.message);
  }

  return ""; // caller decides deterministic fallback
}

// ---------- GIF search (Tenor) ----------
async function fetchGif(query) {
  try {
    if (!TENOR_API_KEY) return null;
    const url = new URL("https://tenor.googleapis.com/v2/search");
    url.searchParams.set("q", query);
    url.searchParams.set("key", TENOR_API_KEY);
    url.searchParams.set("limit", "1");
    url.searchParams.set("media_filter", "minimal");
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const gif = data?.results?.[0];
    const media = gif?.media_formats || gif?.media || {};
    const mp4 = media?.tinygif?.url || media?.gif?.url || media?.mediumgif?.url;
    return mp4 || null;
  } catch (e) {
    console.warn("[GIF] error:", e?.message || e);
    return null;
  }
}

// ---------- Stickers (server-owned only) ----------
const guildStickers = new Map(); // guildId -> array of sticker objects

async function loadGuildStickers(guild) {
  try {
    const coll = await guild.stickers.fetch(); // needs GuildEmojisAndStickers intent
    const list = [...coll.values()].filter(s => s.available !== false);
    guildStickers.set(guild.id, list);
    console.log(`[STICKERS] ${guild.name}: loaded ${list.length} sticker(s)`);
  } catch (e) {
    console.warn(`[STICKERS] Failed to fetch for ${guild.name}:`, e?.message || e);
    guildStickers.set(guild.id, []);
  }
}

function pickRandomSticker(guildId) {
  const list = guildStickers.get(guildId) || [];
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

// ---------- Idle starter ----------
const meta = new Map(); // channelId -> { lastMessageTs, lastStarterTs }
const lastReplies = new Map(); // channelId -> last bot message (to avoid repeats)

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
          // Sometimes send a sticker instead of text
          const roll = Math.random();
          const sticker = roll < STICKER_IDLE_CHANCE ? pickRandomSticker(guild.id) : null;

          if (sticker) {
            await ch.send({ stickers: [sticker] }); // server stickers only
          } else {
            await ch.sendTyping();
            const prompt = `Create ONE short, upbeat, welcoming opener for #${ch.name} (max 45 words).
Tone: positive, inclusive, playful.
Avoid words like quiet, dead, crickets, ghost town, or calling people out.
End with a friendly question that invites anyone to jump in.`;

            const ai = await aiReply(prompt, null);
            const text = (ai || cheekyStarter(ch.name)).trim();

            if (lastReplies.get(ch.id) === text) return;

            await ch.send({ content: text, allowedMentions: { parse: [] } });
            lastReplies.set(ch.id, text);
          }

          markStarter(ch.id);
        } catch (e) {
          console.warn("starter failed for channel", ch.id, e?.message || e);
        }
      }
    }
  }
}

// ---------- Scheduled sticker broadcast (every ~2 hours with jitter) ----------
let nextStickerAt = Date.now();
function scheduleNextSticker() {
  const base = STICKER_BROADCAST_INTERVAL_MIN * 60 * 1000;
  const jitter = (Math.random() * 2 - 1) * (STICKER_BROADCAST_JITTER_MIN * 60 * 1000); // +/- jitter
  nextStickerAt = Date.now() + Math.max(10_000, base + jitter);
}
scheduleNextSticker();

async function stickerBroadcastSweep() {
  if (!STICKER_BROADCAST_ENABLED) return;
  const now = Date.now();
  if (now < nextStickerAt) return;

  try {
    for (const [, guild] of client.guilds.cache) {
      // ensure stickers cached
      if (!guildStickers.has(guild.id)) await loadGuildStickers(guild);
      const sticker = pickRandomSticker(guild.id);
      if (!sticker) continue;

      const channels = guild.channels.cache.filter(allowedChannel);
      for (const [, ch] of channels) {
        if (!canSendInChannel(ch)) continue;

        // idle guard: only drop if channel has been quiet for X minutes
        const m = meta.get(ch.id) || {};
        const lastMsg = m.lastMessageTs || 0;
        const quietEnough = (now - lastMsg) > (STICKER_BROADCAST_IDLE_GUARD_MIN * 60 * 1000);
        if (!quietEnough) continue;

        // etiquette: don’t interrupt active threads/convos; we already check quietness
        try {
          await ch.send({ stickers: [sticker] });
        } catch (e) {
          console.warn("[STICKER-BROADCAST] send failed:", e?.message || e);
        }

        // drop to the first eligible channel per guild only (avoid spamming many channels at once)
        break;
      }
    }
  } finally {
    scheduleNextSticker();
  }
}

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojisAndStickers // needed to fetch guild stickers
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Preload stickers for each guild
  for (const [, guild] of client.guilds.cache) {
    await loadGuildStickers(guild);
  }

  for (const [, guild] of client.guilds.cache) {
    const list = guild.channels.cache
      .filter(allowedChannel)
      .map(ch => `#${ch.name} (${ch.id})`)
      .join(", ");
    console.log(`[ALLOWED in ${guild.name}]`, list || "(none)");
  }

  setInterval(idleSweep, 60 * 1000).unref();
  setInterval(stickerBroadcastSweep, 30 * 1000).unref(); // check every 30s; fires when window hits
  buildKnowledgeBase(client).catch(e => console.error("[KB] build error", e));
});

client.on(Events.GuildStickersUpdate, (guild) => {
  // Keep our cache fresh if stickers change
  loadGuildStickers(guild);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!allowedChannel(message.channel)) return;
    if (!canSendInChannel(message.channel)) {
      console.warn("[SKIP] missing perms in channel:", message.channel?.name);
      return;
    }

    // Don't interrupt direct conversations between humans:
    // 1) If message is a reply to someone (and not us), skip unless they @mention us.
    if (message.reference && !message.mentions.has(client.user)) return;
    // 2) If message @mentions someone else (and not us), skip.
    if (message.mentions.users.size > 0 && !message.mentions.has(client.user)) return;

    markMessage(message.channelId);

    const content = (message.content || "").trim();
    const chance = isQuestion(content) ? REPLY_CHANCE_QUESTION : REPLY_CHANCE;

    // probabilistic participation (no @mention required)
    if (!message.mentions.has(client.user) && Math.random() > chance) return;

    // --- GIF handling ---
    if (looksLikeGifRequest(content)) {
      const query = extractGifQuery(content) || "funny";
      if (!TENOR_API_KEY) {
        await message.channel.send({
          content: `I can drop GIFs if you add a TENOR_API_KEY in my environment settings. Try “gif: dancing bears” after that.`
        });
        return;
      }
      await message.channel.sendTyping();
      const gifUrl = await fetchGif(query);
      if (gifUrl) {
        await message.channel.send({ content: gifUrl, allowedMentions: { parse: [] } });
      } else {
        await message.channel.send({ content: `Couldn't fetch a gif for “${query}” — try another phrase?` });
      }
      return;
    }

    // --- KB grounding for questions ---
    let kbText = "";
    if (isQuestion(content) && KB.length) {
      const snips = retrieveSnippets(content, KB_MAX_SNIPPETS);
      if (snips) kbText = snips;
    }

    await message.channel.sendTyping();

    const prompt = `Channel: #${message.channel.name}
User said: ${content.slice(0, 800)}`;

    let out = await aiReply(prompt, kbText || null);

    // Deterministic fallbacks if model returns nothing
    if (!out) {
      if (kbText) {
        out = `I can't see a clear answer in the notes. Check #official-links or ask a mod for the latest details.`;
      } else if (isQuestion(content)) {
        out = `I don't have that to hand just yet — can you check #official-links or the pinned messages?`;
      } else {
        out = `Noted. Fancy turning that into a question so I can help properly?`;
      }
    }

    // avoid repeating the same reply back-to-back
    if (lastReplies.get(message.channelId) === out) {
      out += " (and yes, I meant to say that clearly this time!)";
    }

    await message.channel.send({ content: out, allowedMentions: { parse: [] } });
    lastReplies.set(message.channelId, out);
  } catch (e) {
    console.error("on message error:", e?.message || e);
  }
});

client.login(process.env.DISCORD_TOKEN);
