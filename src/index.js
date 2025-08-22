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

/* =====================
   ENV / CONFIG
===================== */
const REPLY_CHANCE = Number(process.env.REPLY_CHANCE) || 0.30;
const REPLY_CHANCE_QUESTION = Number(process.env.REPLY_CHANCE_QUESTION) || 0.85;

const IDLE_MINUTES = Number(process.env.IDLE_MINUTES) || 30;
const STARTER_COOLDOWN_MINUTES = Number(process.env.STARTER_COOLDOWN_MINUTES) || 45;

const LANGUAGE = process.env.LANGUAGE || "en-GB";
const TIMEZONE = process.env.TIMEZONE || "Europe/London";
if (!process.env.TZ) process.env.TZ = TIMEZONE;

const MODEL = process.env.MODEL || "openrouter/auto";
const FALLBACK_MODEL = process.env.MODEL_FALLBACK || "openrouter/auto";
const THROTTLE_MS = Number(process.env.AI_THROTTLE_MS) || 6000;

const TENOR_API_KEY = process.env.TENOR_API_KEY || "";

const KB_MAX_SNIPPETS = Number(process.env.KB_MAX_SNIPPETS) || 6;
const KB_MIN_SCORE = Number(process.env.KB_MIN_SCORE) || 2;
const KB_RECENCY_BOOST_DAYS = Number(process.env.KB_RECENCY_BOOST_DAYS) || 45;

const STARTER_USE_AI = String(process.env.STARTER_USE_AI || "false").toLowerCase() === "true";

/* Stickers */
const STICKER_IDLE_CHANCE = Number(process.env.STICKER_IDLE_CHANCE ?? 0.05); // 5% chance on idle nudge
const STICKER_DAILY_LIMIT = Number(process.env.STICKER_DAILY_LIMIT ?? 3);    // up to 3/day
const STICKER_DAY_START_HOUR = Number(process.env.STICKER_DAY_START_HOUR ?? 9);
const STICKER_DAY_END_HOUR   = Number(process.env.STICKER_DAY_END_HOUR ?? 21);

/* Magic Eden */
const MAGIC_EDEN_COLLECTION_SYMBOL = process.env.MAGIC_EDEN_COLLECTION_SYMBOL || ""; // e.g. "yourcollection"
const MAGICEDEN_API_KEY = process.env.MAGICEDEN_API_KEY || ""; // optional; improves rate limit

/* Channel allowlist */
const allowlist = (process.env.CHANNEL_NAME_ALLOWLIST || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const allowlistSet = new Set(allowlist);

/* KB channel IDs (optional) */
const KB_ID_LIST = (process.env.KNOWLEDGE_CHANNEL_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

/* =====================
   UTILITIES
===================== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

/* =====================
   STARTERS (sassier)
===================== */
function cheekyStarter(channelName) {
  const base = [
    `Alright #${channelName}, brag time: what tiny win are you claiming today? I’ll clap loudest. 👏`,
    `Tea break audit: what’s in your mug and why is it your personality? ☕️😄`,
    `Pitch me one bold idea for the project — sensible or spicy, your call. 🌶️`,
    `Two truths and a lie about your day — I’ll guess terribly. 🕵️`,
    `What’s your current grind tune? I’m building a playlist of questionable bangers. 🎧`,
    `If we shipped one delightfully unnecessary feature this week, what would it be? ✨`,
    `Confess a harmless hot take (PG, mind you). I’ll judge gently. 😏`,
    `Drop a meme that sums up your week — bonus points for originality. 🧠`,
    `Tea dunkers vs anti-dunkers: state your case in 10 words or less. ⚖️`,
    `What’s one question you’re low-key hoping someone asks today? Ask it yourself. 🔁`
  ];
  const month = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, month: "numeric" }).format(new Date()));
  let seasonal = [];
  if ([12,1,2].includes(month)) seasonal = [
    `Winter mode: cosy snack + comfort watch? I’m taking notes. ❄️📺`,
    `One skill you’ll level up before spring — go on record. 🌱`
  ];
  else if ([3,4,5].includes(month)) seasonal = [
    `Spring clean your habits: what tiny swap is paying off? 🌼`,
    `Fresh start Friday (even if not Friday): what’s yours? 🧽`
  ];
  else if ([6,7,8].includes(month)) seasonal = [
    `Summer question: iced brew or classic cuppa — and defend it. 🧊☕`,
    `If holiday mode had a status bar, what % are you at? 🏖️`
  ];
  else seasonal = [
    `Autumn vibe check: what’s your cosy ritual? 🍂`,
    `Before month-end: one thing you want Future You to high-five. ✅`
  ];
  const all = [...base, ...seasonal];
  const weekIndex = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return all[weekIndex % all.length];
}

/* =====================
   KNOWLEDGE BASE
===================== */
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

  const nameTargets = (process.env.KNOWLEDGE_CHANNELS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const idTargets = new Set(KB_ID_LIST);

  console.log("[KB] Target names:", nameTargets.length ? nameTargets.join(", ") : "(none)");
  console.log("[KB] Target IDs  :", idTargets.size ? [...idTargets].join(", ") : "(none)");

  if (!nameTargets.length && !idTargets.size) {
    console.log("[KB] No knowledge channels configured — skipping.");
    return;
  }

  for (const [, guild] of client.guilds.cache) {
    console.log(`[KB] Scanning guild: ${guild.name}`);
    let channels;
    try {
      channels = await guild.channels.fetch();
    } catch (e) {
      console.warn("[KB] Could not fetch channels for guild:", guild.name, e?.message || e);
      continue;
    }

    for (const [, ch] of channels) {
      if (!ch || ch.type !== ChannelType.GuildText) continue;

      const cname = (ch.name || "").toLowerCase();
      const isNameTarget = nameTargets.includes(cname);
      const isIdTarget = idTargets.has(ch.id);
      if (!isNameTarget && !isIdTarget) continue;

      const readable = canReadChannel(ch);
      console.log(`[KB] Candidate #${ch.name} (${ch.id}) — nameMatch=${isNameTarget} idMatch=${isIdTarget} readable=${readable}`);

      if (!readable) {
        console.warn(`[KB] Missing perms for #${ch.name}: need View Channel + Read Message History`);
        continue;
      }

      try {
        const perChannelMax = Math.min(800, Number(process.env.KNOWLEDGE_MAX_MESSAGES) || 1500);
        const msgs = await fetchHistory(ch, perChannelMax);
        console.log(`[KB] #${ch.name}: fetched ${msgs.length}`);
        KB.push(...msgs);
      } catch (e) {
        console.warn("[KB] fetchHistory failed on", ch.name, e?.message || e);
      }
    }
  }

  KB.sort((a, b) => b.ts - a.ts);
  console.log(`[KB] Loaded ${KB.length} messages`);
}
function retrieveSnippets(question, k = KB_MAX_SNIPPETS) {
  const qTokens = tokens(question);
  if (!KB.length || !qTokens.length) return "";
  const scored = KB
    .map(d => ({ d, s: scoreDoc(qTokens, d) }))
    .filter(x => x.s >= KB_MIN_SCORE)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(x => x.d);
  if (!scored.length) return "";
  return scored
    .map(d => `[#${d.channelName}] ${ukDate(d.ts)} — ${d.content}`)
    .join("\n\n");
}

/* =====================
   OPENAI CLIENT + THROTTLE
===================== */
const aiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "",
  baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1"
});
let lastCallAt = 0;
async function throttle() {
  const now = Date.now();
  const delta = now - lastCallAt;
  if (delta < THROTTLE_MS) {
    await sleep(THROTTLE_MS - delta);
  }
  lastCallAt = Date.now();
}
async function modelCall(model, messages) {
  await throttle();
  return aiClient.chat.completions.create({
    model,
    temperature: 0.6,
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
Be helpful, direct, and add ONE playful line at most.

User question:
${prompt}

PROJECT NOTES:
${kbText}`
    : prompt;

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: userMsg },
    { role: "system", content: `Language: ${LANGUAGE}. If grounded, do not invent info.` }
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await modelCall(MODEL, messages);
      let out = res?.choices?.[0]?.message?.content?.trim() || "";
      if (out && !/[.!?]$/.test(out)) out += ".";
      if (out) return out;
    } catch (e) {
      const code = e?.status || e?.code || "";
      console.warn("[AI] Primary model failed:", code, e?.message || "");
      if (code === 429 || code === "insufficient_quota") {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      break;
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
  return "";
}

/* =====================
   GIFs (Tenor)
===================== */
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

/* =====================
   STICKERS (server-owned)
===================== */
const guildStickers = new Map(); // guildId -> sticker[]
async function loadGuildStickers(guild) {
  try {
    const coll = await guild.stickers.fetch();
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

/* =====================
   IDLE + SCHEDULED STICKERS
===================== */
const meta = new Map(); // channelId -> { lastMessageTs, lastStarterTs }
const lastReplies = new Map(); // channelId -> last bot message

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
          if (Math.random() < STICKER_IDLE_CHANCE) {
            const sticker = pickRandomSticker(guild.id);
            if (sticker) {
              await ch.send({ stickers: [sticker] });
              markStarter(ch.id);
              continue;
            }
          }
          await ch.sendTyping();
          const prompt = `Create ONE short, upbeat opener for #${ch.name} (max 45 words).
Be sassy-but-kind, witty, inclusive. Avoid words like "dead/quiet/crickets".
End with a question that invites easy replies.`;
          let text = cheekyStarter(ch.name);
          if (STARTER_USE_AI) {
            const ai = await aiReply(prompt, null);
            text = (ai || text).trim();
          } else {
            text = text.trim();
          }
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

/* Scheduled stickers: up to N/day at random UK times */
const stickerDailyCount = new Map(); // guildId -> { dateKey, count }
const nextStickerAtByGuild = new Map(); // guildId -> ts

function ukNowDateObj() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).format(now).replace(",", "");
  return new Date(parts.replace(" ", "T") + "Z");
}
function ukDayKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}
function nextRandomUKTimeTodayOrTomorrow() {
  const now = ukNowDateObj();
  const start = new Date(now);
  start.setHours(STICKER_DAY_START_HOUR, 0, 0, 0);
  const end = new Date(now);
  end.setHours(STICKER_DAY_END_HOUR, 0, 0, 0);

  let base;
  if (now < start) base = start;
  else if (now > end) { base = new Date(start); base.setDate(base.getDate() + 1); }
  else base = now;

  const effectiveEnd = (base.getDate() === end.getDate()) ? end : new Date(end.getTime() + 24*60*60*1000);
  const span = effectiveEnd.getTime() - base.getTime();
  const target = new Date(base.getTime() + Math.random() * Math.max(span, 1));
  return target.getTime();
}
function scheduleNextStickerForGuild(guildId) {
  const t = nextRandomUKTimeTodayOrTomorrow();
  nextStickerAtByGuild.set(guildId, t);
  console.log(`[STICKERS] Next scheduled sticker for guild ${guildId} at ~ ${ukDate(t)}`);
}
function canPostStickerForGuild(guildId) {
  const key = ukDayKey();
  const rec = stickerDailyCount.get(guildId) || { dateKey: key, count: 0 };
  if (rec.dateKey !== key) { rec.dateKey = key; rec.count = 0; }
  if (rec.count >= STICKER_DAILY_LIMIT) return false;
  return true;
}
function markStickerPosted(guildId) {
  const key = ukDayKey();
  const rec = stickerDailyCount.get(guildId) || { dateKey: key, count: 0 };
  if (rec.dateKey !== key) { rec.dateKey = key; rec.count = 0; }
  rec.count += 1;
  stickerDailyCount.set(guildId, rec);
  console.log(`[STICKERS] Daily count for ${guildId}: ${rec.count}/${STICKER_DAILY_LIMIT} (${rec.dateKey})`);
}
async function scheduledStickerSweep() {
  const now = Date.now();
  for (const [, guild] of client.guilds.cache) {
    if (!canPostStickerForGuild(guild.id)) {
      if (!nextStickerAtByGuild.has(guild.id)) scheduleNextStickerForGuild(guild.id);
      continue;
    }
    if (!nextStickerAtByGuild.has(guild.id)) {
      scheduleNextStickerForGuild(guild.id);
      continue;
    }
    const dueAt = nextStickerAtByGuild.get(guild.id);
    if (now < dueAt) continue;

    try {
      const sticker = pickRandomSticker(guild.id);
      if (!sticker) { scheduleNextStickerForGuild(guild.id); continue; }

      const quietMs = 15 * 60 * 1000;
      const channels = guild.channels.cache.filter(allowedChannel);
      let posted = false;
      for (const [, ch] of channels) {
        if (!canSendInChannel(ch)) continue;
        const m = meta.get(ch.id) || {};
        const lastMsg = m.lastMessageTs || 0;
        if (Date.now() - lastMsg < quietMs) continue;
        await ch.send({ stickers: [sticker] });
        posted = true;
        markStickerPosted(guild.id);
        break;
      }
      scheduleNextStickerForGuild(guild.id);
      if (!posted) {
        console.log("[STICKERS] No suitably quiet channel found; will try next window.");
      }
    } catch (e) {
      console.warn("[STICKERS] scheduled send failed:", e?.message || e);
      scheduleNextStickerForGuild(guild.id);
    }
  }
}

/* =====================
   MAGIC EDEN HELPERS
===================== */
const ME_BASE = "https://api-mainnet.magiceden.dev";

function meHeaders() {
  const h = { "accept": "application/json" };
  if (MAGICEDEN_API_KEY) {
    // Support either Bearer or x-api-key styles
    h["Authorization"] = `Bearer ${MAGICEDEN_API_KEY}`;
    h["x-api-key"] = MAGICEDEN_API_KEY;
  }
  return h;
}

// Floor price / listed count / volume etc.
async function meFetchStats(symbol) {
  if (!symbol) return null;
  try {
    const res = await fetch(`${ME_BASE}/v2/collections/${encodeURIComponent(symbol)}/stats`, {
      headers: meHeaders()
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data; // { floorPrice, listedCount, avgPrice24hr, volume24hr, volumeAll, ... } (lamports if SOL)
  } catch (e) {
    console.warn("[ME] stats error:", e?.message || e);
    return null;
  }
}

// Collection attributes/traits
async function meFetchAttributes(symbol) {
  if (!symbol) return [];
  // try attributes, fallback to traits
  const tryPaths = [
    `${ME_BASE}/v2/collections/${encodeURIComponent(symbol)}/attributes`,
    `${ME_BASE}/v2/collections/${encodeURIComponent(symbol)}/traits`
  ];
  for (const url of tryPaths) {
    try {
      const res = await fetch(url, { headers: meHeaders() });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data)) return data; // assume array of {trait_type,value,count} or similar
      if (data?.attributes && Array.isArray(data.attributes)) return data.attributes;
      if (data?.traits && Array.isArray(data.traits)) return data.traits;
    } catch (e) {
      console.warn("[ME] attr error:", e?.message || e);
    }
  }
  return [];
}

// Sales (last 24h): count buy events in activity
async function meFetchSales24h(symbol) {
  if (!symbol) return null;
  try {
    const since = Math.floor((Date.now() - 24*60*60*1000) / 1000);
    // pull a page of recent activities; if needed, increase limit
    const res = await fetch(`${ME_BASE}/v2/collections/${encodeURIComponent(symbol)}/activities?offset=0&limit=200`, {
      headers: meHeaders()
    });
    if (!res.ok) return null;
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.activities || [];
    let count = 0;
    for (const a of list) {
      const ts = a?.blockTime || a?.createdAt || 0;
      const type = (a?.type || a?.eventType || "").toLowerCase();
      if (!ts || ts < since) continue;
      if (type.includes("buy") || type.includes("sold") || type.includes("sale")) count++;
    }
    return count;
  } catch (e) {
    console.warn("[ME] sales error:", e?.message || e);
    return null;
  }
}

function lamportsToSOL(v) {
  // if value looks huge, assume lamports
  if (typeof v !== "number") return v;
  if (v > 1_000_000) return (v / 1_000_000_000).toFixed(3) + " SOL";
  return v.toString();
}

/* =====================
   MEMBER INSIGHT
===================== */
// Short, cheeky summary about a mentioned member (public info only)
async function describeMember(guild, userId, channelForScan) {
  try {
    const member = await guild.members.fetch(userId);
    const display = member.displayName || member.user.username;
    const joined = member.joinedTimestamp ? ukDate(member.joinedTimestamp) : "unknown";
    const created = member.user.createdTimestamp ? ukDate(member.user.createdTimestamp) : "unknown";
    const roles = member.roles.cache
      .filter(r => r.name !== "@everyone")
      .map(r => r.name)
      .slice(0, 6);

    // try to find their most recent message in this channel (lightweight peek)
    let recentSnippet = "";
    try {
      const msgs = await channelForScan.messages.fetch({ limit: 50 });
      const lastByUser = [...msgs.values()].find(m => m.author?.id === userId && m.content?.trim());
      if (lastByUser) {
        recentSnippet = lastByUser.content.trim().slice(0, 120);
      }
    } catch { /* ignore */ }

    const parts = [];
    parts.push(`**${display}**`);
    parts.push(`• Joined server: ${joined}`);
    parts.push(`• Discord account: ${created}`);
    if (roles.length) parts.push(`• Roles: ${roles.join(", ")}`);
    if (recentSnippet) parts.push(`• Last seen saying: “${recentSnippet}”`);

    // add a tiny cheeky sign-off
    parts.push(`Certified decent human (99% chance) — unless proven otherwise by biscuit choice. 😉`);

    return parts.join("\n");
  } catch (e) {
    return `I can't fetch that member here — they might be new, hidden from my perms, or not in this server.`;
  }
}

/* =====================
   DISCORD CLIENT
===================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildMembers // needed for member lookup
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const [, guild] of client.guilds.cache) {
    await loadGuildStickers(guild);
    scheduleNextStickerForGuild(guild.id);
  }

  for (const [, guild] of client.guilds.cache) {
    const list = guild.channels.cache
      .filter(allowedChannel)
      .map(ch => `#${ch.name} (${ch.id})`)
      .join(", ");
    console.log(`[ALLOWED in ${guild.name}]`, list || "(none)");
  }

  setTimeout(() => {
    buildKnowledgeBase(client).catch(e => console.error("[KB] build error", e));
  }, 3000);

  setInterval(idleSweep, 60 * 1000).unref();
  setInterval(scheduledStickerSweep, 60 * 1000).unref();
});

client.on(Events.GuildStickersUpdate, (guild) => {
  loadGuildStickers(guild);
});

/* =====================
   MESSAGE HANDLER
===================== */
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!allowedChannel(message.channel)) return;
    if (!canSendInChannel(message.channel)) {
      console.warn("[SKIP] missing perms in channel:", message.channel?.name);
      return;
    }

    // etiquette: don't interrupt direct human replies or other @mentions
    if (message.reference && !message.mentions.has(client.user)) return;
    if (message.mentions.users.size > 0 && !message.mentions.has(client.user)) return;

    markMessage(message.channelId);
    const content = (message.content || "").trim();

    /* ----- Commands / Smart intents first ----- */

    // 1) Member insight: "tell me something about @user", "who is @user", "info on @user"
    const mention = message.mentions.users.first();
    if (mention && /\b(tell me something about|who is|info on|about)\b/i.test(content)) {
      const summary = await describeMember(message.guild, mention.id, message.channel);
      await message.channel.send({ content: summary, allowedMentions: { parse: [] } });
      return;
    }

    // 2) GIF request
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

    // 3) Magic Eden Qs (floor, listed, sold, traits)
    const wantsME = /magic\s*eden|floor price|floor\b|listed\b|on the floor|how many sold|sales|traits|rarity/i.test(content);
    if (wantsME && MAGIC_EDEN_COLLECTION_SYMBOL) {
      await message.channel.sendTyping();
      const [stats, sales24h, attrs] = await Promise.all([
        meFetchStats(MAGIC_EDEN_COLLECTION_SYMBOL),
        meFetchSales24h(MAGIC_EDEN_COLLECTION_SYMBOL),
        meFetchAttributes(MAGIC_EDEN_COLLECTION_SYMBOL)
      ]);

      let floorStr = "unknown";
      let listedStr = "unknown";
      if (stats) {
        floorStr = lamportsToSOL(stats.floorPrice);
        listedStr = String(stats.listedCount ?? "unknown");
      }

      let rareLine = "";
      if (Array.isArray(attrs) && attrs.length) {
        // Normalise to {trait_type, value, count}
        const items = attrs.map(a => {
          if (a.trait_type && a.value && a.count != null) return a;
          const keys = Object.keys(a || {});
          // try to guess
          return {
            trait_type: a.trait_type || a.traitType || "Trait",
            value: a.value || a.name || a.val || (keys[0] || "Value"),
            count: a.count || a.quantity || a.num || 0
          };
        }).filter(x => x.count != null);

        // Rarest 3 by ascending count
        items.sort((x, y) => (x.count ?? 0) - (y.count ?? 0));
        const top = items.slice(0, 3);
        if (top.length) {
          rareLine = top.map(t => `${t.trait_type}: ${t.value} (${t.count} pcs)`).join(" · ");
        }
      }

      const bits = [];
      bits.push(`**Magic Eden — ${MAGIC_EDEN_COLLECTION_SYMBOL}**`);
      bits.push(`• Floor: ${floorStr}`);
      bits.push(`• Listed (“on the floor”): ${listedStr}`);
      if (sales24h != null) bits.push(`• Sold (last 24h): ${sales24h}`);
      if (rareLine) bits.push(`• Rare traits to watch: ${rareLine}`);
      bits.push(`If you want a deeper dig, shout a specific: "floor", "traits", or "sold in 24h".`);
      bits.push(`Now, who’s hunting grails and who’s bargain diving? 🛒😏`);

      await message.channel.send({ content: bits.join("\n"), allowedMentions: { parse: [] } });
      return;
    }

    /* ----- Normal chat participation (probabilistic) ----- */
    const chance = isQuestion(content) ? REPLY_CHANCE_QUESTION : REPLY_CHANCE;
    if (!message.mentions.has(client.user) && Math.random() > chance) return;

    // Knowledge grounding for questions
    let kbText = "";
    if (isQuestion(content) && KB.length) {
      const snips = retrieveSnippets(content, KB_MAX_SNIPPETS);
      if (snips) kbText = snips;
    }

    await message.channel.sendTyping();
    const prompt = `Channel: #${message.channel.name}
User said: ${content.slice(0, 800)}`;

    let out = await aiReply(prompt, kbText || null);
    if (!out) {
      if (kbText) {
        out = `I can't see a clear answer in the notes. Check #official-links or ask a mod for the latest details.`;
      } else if (isQuestion(content)) {
        out = `I don't have that to hand just yet — can you check #official-links or the pinned messages?`;
      } else {
        out = `Noted. Fancy turning that into a question so I can help properly?`;
      }
    }
    if (lastReplies.get(message.channelId) === out) {
      out += " (yes, I really meant that — twice for clarity!)";
    }
    await message.channel.send({ content: out, allowedMentions: { parse: [] } });
    lastReplies.set(message.channelId, out);

  } catch (e) {
    console.error("on message error:", e?.message || e);
  }
});

/* =====================
   BOOT
===================== */
client.login(process.env.DISCORD_TOKEN);

/* After login */
client.on(Events.ClientReady, () => {
  console.log("Instance ready & healthy");
});
