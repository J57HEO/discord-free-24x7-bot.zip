// OUKII Discord Bot — src/index.js (drop‑in)
// Node 18+, discord.js v14
// Behaviour is driven by PROJECT_BRIEF.md and .env values.

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ChannelType, Collection, EmbedBuilder } from 'discord.js';
import axios from 'axios';

// ---------- Env & defaults ----------
const env = (k, d = undefined) => process.env[k] ?? d;

const CONFIG = {
  // Discord
  DISCORD_TOKEN: env('DISCORD_TOKEN'),

  // OpenRouter / OpenAI-compatible
  OPENAI_API_KEY: env('OPENAI_API_KEY'),
  OPENAI_BASE_URL: env('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1'),
  MODEL: env('MODEL', 'openrouter/auto'),
  MODEL_FALLBACK: env('MODEL_FALLBACK', 'openrouter/auto'),

  // Behaviour
  CHANNEL_NAME_ALLOWLIST: new Set((env('CHANNEL_NAME_ALLOWLIST', 'bot-test') || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)),
  REPLY_CHANCE: Number(env('REPLY_CHANCE', '0.30')),
  REPLY_CHANCE_QUESTION: Number(env('REPLY_CHANCE_QUESTION', '0.85')),
  IDLE_MINUTES: Number(env('IDLE_MINUTES', '25')),
  STARTER_COOLDOWN_MINUTES: Number(env('STARTER_COOLDOWN_MINUTES', '45')),
  STARTER_USE_AI: /^(true|1)$/i.test(env('STARTER_USE_AI', 'false')),

  // Locale / time
  TZ: env('TZ', 'Europe/London'),
  TIMEZONE: env('TIMEZONE', 'Europe/London'),
  LANGUAGE: env('LANGUAGE', 'en-GB'),

  // Knowledge base
  KNOWLEDGE_CHANNEL_IDS: (env('KNOWLEDGE_CHANNEL_IDS', '') || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  KNOWLEDGE_CHANNELS: (env('KNOWLEDGE_CHANNELS', '') || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  KNOWLEDGE_MAX_MESSAGES: Number(env('KNOWLEDGE_MAX_MESSAGES', '1500')),

  // Prompt budgets (rough cut, we do character based truncation)
  AI_MAX_INPUT_TOKENS: Number(env('AI_MAX_INPUT_TOKENS', '900')),
  AI_MAX_RESPONSE_TOKENS: Number(env('AI_MAX_RESPONSE_TOKENS', '160')),
  AI_MIN_RESPONSE_TOKENS: Number(env('AI_MIN_RESPONSE_TOKENS', '60')),
  AI_RETRY_ON_402: /^(true|1)$/i.test(env('AI_RETRY_ON_402', 'true')),
  KB_MAX_SNIPPETS: Number(env('KB_MAX_SNIPPETS', '2')),
  KB_SNIPPET_CHARS: Number(env('KB_SNIPPET_CHARS', '150')),
  KB_TOTAL_CHARS: Number(env('KB_TOTAL_CHARS', '400')),
  AI_THROTTLE_MS: Number(env('AI_THROTTLE_MS', '6000')),

  // Media
  TENOR_API_KEY: env('TENOR_API_KEY', ''),

  // Stickers
  STICKER_DAILY_LIMIT: Number(env('STICKER_DAILY_LIMIT', '3')),
  STICKER_IDLE_CHANCE: Number(env('STICKER_IDLE_CHANCE', '0.05')),
  STICKER_DAY_START_HOUR: Number(env('STICKER_DAY_START_HOUR', '9')),
  STICKER_DAY_END_HOUR: Number(env('STICKER_DAY_END_HOUR', '21')),

  // Magic Eden
  MAGIC_EDEN_COLLECTION_SYMBOL: env('MAGIC_EDEN_COLLECTION_SYMBOL', 'oukii'),
  MAGICEDEN_API_KEY: env('MAGICEDEN_API_KEY', ''),
};

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // requires privileged intent in Dev Portal
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---------- Small utils ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const now = () => new Date();
const isQuestionLike = (s) => /\?$/.test(s.trim()) || /^(who|what|when|where|why|how|does|do|is|are|can|should|could)\b/i.test(s.trim());
const withinHours = (d, startHour, endHour) => {
  const h = d.getHours();
  return h >= startHour && h < endHour;
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Track per-channel last activity and last starter time
const lastMessageAt = new Map();
const lastStarterAt = new Map();

// Sticker counters
let stickerDayKey = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
let stickerCountToday = 0;

function resetStickerDailyIfNeeded() {
  const key = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
  if (key !== stickerDayKey) {
    stickerDayKey = key;
    stickerCountToday = 0;
  }
}

function allowedChannel(channel) {
  try {
    if (!channel || channel.type !== ChannelType.GuildText) return false;
    if (CONFIG.CHANNEL_NAME_ALLOWLIST.size === 0) return true;
    return CONFIG.CHANNEL_NAME_ALLOWLIST.has(channel.name);
  } catch { return false; }
}

// ---------- Icebreakers (short, UK tone) ----------
const FALLBACK_STARTERS = [
  "What’s everyone working on today?", 
  "Tea or coffee this afternoon? ☕", 
  "What’s one small win you had this week?",
  "Drop a tune you’ve had on repeat lately!",
  "What’s your go‑to productivity hack, then?",
];

// ---------- Knowledge retrieval (lightweight) ----------
async function gatherKnowledgeSnippets(guild, queryText) {
  try {
    const channels = [];
    // Prefer explicit IDs
    for (const id of CONFIG.KNOWLEDGE_CHANNEL_IDS) {
      const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
      if (ch && ch.type === ChannelType.GuildText) channels.push(ch);
    }
    // Fallback by names
    if (!channels.length && CONFIG.KNOWLEDGE_CHANNELS.length) {
      for (const ch of guild.channels.cache.values()) {
        if (ch.type === ChannelType.GuildText && CONFIG.KNOWLEDGE_CHANNELS.includes(ch.name)) channels.push(ch);
      }
    }
    if (!channels.length) return [];

    const lower = queryText.toLowerCase();
    const snippets = [];
    for (const ch of channels) {
      // Pull recent messages in batches (rate limited) up to KNOWLEDGE_MAX_MESSAGES
      let fetched = 0;
      let beforeId = undefined;
      while (fetched < CONFIG.KNOWLEDGE_MAX_MESSAGES) {
        const batch = await ch.messages.fetch({ limit: 100, before: beforeId }).catch(() => null);
        if (!batch || batch.size === 0) break;
        for (const msg of batch.values()) {
          const content = (msg.content || '').replace(/<@[!&]?[0-9]+>/g, '@user'); // de‑identify
          const text = content.toLowerCase();
          if (text.includes(lower) || (lower.length > 3 && text.includes(lower.slice(0, 4)))) {
            snippets.push(content);
            if (snippets.length >= CONFIG.KB_MAX_SNIPPETS) break;
          }
        }
        if (snippets.length >= CONFIG.KB_MAX_SNIPPETS) break;
        fetched += batch.size;
        beforeId = batch.last().id;
      }
      if (snippets.length >= CONFIG.KB_MAX_SNIPPETS) break;
    }

    const trimmed = [];
    let total = 0;
    for (const s of snippets) {
      const t = s.slice(0, CONFIG.KB_SNIPPET_CHARS);
      if (total + t.length > CONFIG.KB_TOTAL_CHARS) break;
      total += t.length;
      trimmed.push(t);
    }
    return trimmed;
  } catch (err) {
    console.warn('KB gather error', err);
    return [];
  }
}

// ---------- OpenAI / OpenRouter call ----------
let lastAICallAt = 0;

function extractAffordableTokens(err) {
  try {
    const msg = err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || '';
    // Examples we handle:
    // "This request requires more credits, or fewer max_tokens. You requested up to 200 tokens, but can only afford 189."
    let m = msg.match(/can only afford\s+(\d+)/i);
    if (m) return Number(m[1]);
    m = msg.match(/afford\s+(\d+)/i);
    if (m) return Number(m[1]);
    return null;
  } catch { return null; }
}

async function askAI({ system, user }) {
  const since = Date.now() - lastAICallAt;
  if (since < CONFIG.AI_THROTTLE_MS) {
    await sleep(CONFIG.AI_THROTTLE_MS - since);
  }
  lastAICallAt = Date.now();

  let maxTokens = CONFIG.AI_MAX_RESPONSE_TOKENS;
  const baseBody = {
    model: CONFIG.MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user.slice(0, CONFIG.AI_MAX_INPUT_TOKENS * 4) }, // rough char guard
    ],
  };

  const headers = {
    'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const url = `${CONFIG.OPENAI_BASE_URL}/chat/completions`;

  async function send(model, tokens) {
    const body = { ...baseBody, model, max_tokens: tokens };
    const res = await axios.post(url, body, { headers, timeout: 30000 });
    const text = res.data?.choices?.[0]?.message?.content?.trim();
    return text || '';
  }

  try {
    // Primary model
    try {
      return await send(CONFIG.MODEL, maxTokens);
    } catch (err) {
      const status = err?.response?.status;
      console.warn('[AI] Primary model failed:', status || err?.message);
      if (status === 402 && CONFIG.AI_RETRY_ON_402) {
        const affordable = extractAffordableTokens(err);
        if (affordable && affordable < maxTokens) {
          const adjusted = clamp(affordable - 5, CONFIG.AI_MIN_RESPONSE_TOKENS, maxTokens);
          if (adjusted >= CONFIG.AI_MIN_RESPONSE_TOKENS) {
            console.warn(`[AI] Retrying primary with max_tokens=${adjusted}`);
            try { return await send(CONFIG.MODEL, adjusted); } catch (e2) {
              console.warn('[AI] Primary retry failed:', e2?.response?.status || e2?.message);
            }
          }
        }
      }
      // Fallback
      if (CONFIG.MODEL_FALLBACK && CONFIG.MODEL_FALLBACK !== CONFIG.MODEL) {
        try {
          return await send(CONFIG.MODEL_FALLBACK, maxTokens);
        } catch (err2) {
          const status2 = err2?.response?.status;
          console.warn('[AI] Fallback model failed:', status2 || err2?.message);
          if (status2 === 402 && CONFIG.AI_RETRY_ON_402) {
            const affordable2 = extractAffordableTokens(err2);
            if (affordable2 && affordable2 < maxTokens) {
              const adjusted2 = clamp(affordable2 - 5, CONFIG.AI_MIN_RESPONSE_TOKENS, maxTokens);
              if (adjusted2 >= CONFIG.AI_MIN_RESPONSE_TOKENS) {
                console.warn(`[AI] Retrying fallback with max_tokens=${adjusted2}`);
                try { return await send(CONFIG.MODEL_FALLBACK, adjusted2); } catch (e3) {
                  console.warn('[AI] Fallback retry failed:', e3?.response?.status || e3?.message);
                }
              }
            }
          }
        }
      }
    }
    return '';
  } catch (err) {
    console.error('AI call catastrophic failure:', err?.response?.status || err?.message);
    return '';
  }
}

// ---------- Tenor (GIFs & stickers) ----------
async function tenorSearch(q, { sticker = false } = {}) {
  if (!CONFIG.TENOR_API_KEY) return null;
  const params = new URLSearchParams({
    key: CONFIG.TENOR_API_KEY,
    client_key: 'oukii_discord_bot',
    q,
    limit: '20',
    locale: CONFIG.LANGUAGE,
    country: 'GB',
  });
  if (sticker) params.set('searchfilter', 'sticker');
  try {
    const url = `https://tenor.googleapis.com/v2/search?${params.toString()}`;
    const { data } = await axios.get(url, { timeout: 12000 });
    const results = data?.results || [];
    if (!results.length) return null;
    const item = pick(results);
    const media = item.media_formats || {};
    const gifUrl = media?.gif?.url || media?.tinygif?.url || media?.mp4?.url || null;
    return gifUrl;
  } catch (e) {
    console.warn('Tenor error', e?.response?.status || e?.message);
    return null;
  }
}

// ---------- Magic Eden (OUKII) ----------
async function fetchMagicEdenStats(symbol = CONFIG.MAGIC_EDEN_COLLECTION_SYMBOL) {
  try {
    const headers = {};
    if (CONFIG.MAGICEDEN_API_KEY) headers['Authorization'] = `Bearer ${CONFIG.MAGICEDEN_API_KEY}`;
    const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/stats`;
    const { data } = await axios.get(url, { headers, timeout: 15000 });
    return data || null;
  } catch (e) {
    console.warn('ME stats error', e?.response?.status || e?.message);
    return null;
  }
}

async function fetchMagicEdenActivities24h(symbol = CONFIG.MAGIC_EDEN_COLLECTION_SYMBOL) {
  try {
    const headers = {};
    if (CONFIG.MAGICEDEN_API_KEY) headers['Authorization'] = `Bearer ${CONFIG.MAGICEDEN_API_KEY}`;
    const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/activities`;
    const { data } = await axios.get(url, { headers, timeout: 15000, params: { limit: 100 } });
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const sales = (data || []).filter(a => a?.type === 'buyNow' && (new Date(a?.blockTime * 1000).getTime() >= since));
    return sales;
  } catch (e) {
    console.warn('ME activities error', e?.response?.status || e?.message);
    return [];
  }
}

// ---------- Message routing ----------
function looksLikeGifRequest(text) {
  return /^gif\s*:\s*(.+)$/i.exec(text) || /\b(send|post)\s+a?\s*(gif|sticker)\s+of\s+(.+)/i.exec(text);
}

function looksLikeStickerDrop(text) {
  return /^sticker\s*:\s*(.+)$/i.exec(text);
}

function looksLikeMemberInsight(text) {
  return /(tell me something about\s+<@!?\d+>|about\s+(me|my profile))/i.test(text);
}

function mentionsOtherUser(message) {
  return message.mentions?.users?.size > 0 && !message.mentions.users.has(message.author.id);
}

function inAllowedThread(message) {
  // Don’t interrupt people: if in a thread with >2 participants recently, skip
  const thread = message.channel;
  return !(thread?.isThread?.() && thread?.memberCount > 2);
}

// ---------- Personality prompt ----------
const SYSTEM_PROMPT = `You are OUKII — a cheeky, kind, UK‑based Discord companion.
Keep replies short (max ~90 words), UK English, never @here/@everyone, GMT/BST.
If you’re not sure, say so briefly. Use knowledge snippets if provided.
`;

// ---------- Idle starter tick ----------
async function maybePostIdleStarter(channel) {
  if (!allowedChannel(channel)) return;
  const nowDt = now();
  resetStickerDailyIfNeeded();
  if (!withinHours(nowDt, CONFIG.STICKER_DAY_START_HOUR, CONFIG.STICKER_DAY_END_HOUR)) {
    // still allow text starters outside sticker hours
  }

  const lastMsg = lastMessageAt.get(channel.id) || 0;
  const lastStarter = lastStarterAt.get(channel.id) || 0;
  const idleMs = CONFIG.IDLE_MINUTES * 60 * 1000;
  const cooldownMs = CONFIG.STARTER_COOLDOWN_MINUTES * 60 * 1000;
  if (Date.now() - lastMsg < idleMs) return;
  if (Date.now() - lastStarter < cooldownMs) return;

  lastStarterAt.set(channel.id, Date.now());

  // 5% chance to drop a sticker instead of text starter
  const dropSticker = Math.random() < CONFIG.STICKER_IDLE_CHANCE;
  if (dropSticker && stickerCountToday < CONFIG.STICKER_DAILY_LIMIT && withinHours(nowDt, CONFIG.STICKER_DAY_START_HOUR, CONFIG.STICKER_DAY_END_HOUR)) {
    const url = await tenorSearch('hello', { sticker: true });
    if (url) {
      stickerCountToday++;
      await channel.send(url);
      return;
    }
  }

  let text = pick(FALLBACK_STARTERS);
  if (CONFIG.STARTER_USE_AI && CONFIG.OPENAI_API_KEY) {
    const ai = await askAI({
      system: SYSTEM_PROMPT,
      user: 'Write one upbeat icebreaker for a Discord server. No hashtags. Keep it under 20 words.'
    });
    if (ai) text = ai.replace(/@here|@everyone/g, '').trim().slice(0, 140);
  }
  await channel.send(text);
}

// Run periodic idle check every minute
setInterval(async () => {
  try {
    for (const guild of client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (allowedChannel(channel)) await maybePostIdleStarter(channel);
      }
    }
  } catch (e) {
    console.warn('Idle check error', e.message);
  }
}, 60 * 1000);

// ---------- Member insight ----------
async function buildMemberInsight(message) {
  const content = message.content;
  const meMatch = /about\s+(me|my profile)/i.test(content);
  let member = null;
  if (meMatch) {
    member = await message.guild.members.fetch(message.author.id);
  } else {
    const m = content.match(/<@!?(\d+)>/);
    if (m) member = await message.guild.members.fetch(m[1]).catch(() => null);
  }
  if (!member) return "I couldn’t find that member, sorry.";

  // Join date & account age
  const joinedAt = member.joinedAt || new Date();
  const createdAt = member.user.createdAt;
  const daysOld = Math.floor((Date.now() - createdAt.getTime()) / (1000*60*60*24));

  // Roles (top few, excluding @everyone)
  const roles = member.roles.cache
    .filter(r => r.name !== '@everyone')
    .sort((a,b) => b.position - a.position)
    .first(3)
    .map(r => r.name);

  // Last snippet (scan recent channel history)
  let snippet = '';
  const recent = await message.channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent) {
    const last = [...recent.values()].find(m => m.author.id === member.id && m.id !== message.id);
    snippet = last?.content ? last.content.slice(0, 120) : '';
  }

  const lines = [
    `Joined: ${joinedAt.toLocaleString('en-GB', { timeZone: CONFIG.TIMEZONE })}`,
    `Account age: ${daysOld} days`,
    roles.length ? `Top roles: ${roles.join(', ')}` : null,
    snippet ? `Recent: “${snippet}”` : null,
    `All good? Lovely jubbly. 🐾`
  ].filter(Boolean);

  return lines.join('\n');
}

// ---------- On ready & messages ----------
client.once(Events.ClientReady, c => {
  console.log(`OUKII online as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return; // ignore DMs
    if (!allowedChannel(message.channel)) return;

    lastMessageAt.set(message.channel.id, Date.now());

    // Don’t interrupt people / mentions of others
    if (mentionsOtherUser(message) || !inAllowedThread(message)) return;

    const text = message.content?.trim() || '';

    // GIF or sticker request
    const gifReq = looksLikeGifRequest(text);
    const stickerReq = looksLikeStickerDrop(text);
    if (gifReq) {
      const query = (gifReq[1] || gifReq[3] || '').trim();
      const isSticker = /sticker/i.test(gifReq[0]);
      const url = await tenorSearch(query, { sticker: isSticker });
      if (url) return void message.channel.send(url);
      return void message.reply('Couldn’t find a good one, sorry!');
    }
    if (stickerReq) {
      const query = (stickerReq[1] || '').trim();
      resetStickerDailyIfNeeded();
      if (stickerCountToday >= CONFIG.STICKER_DAILY_LIMIT) return;
      const url = await tenorSearch(query || 'hello', { sticker: true });
      if (url) {
        stickerCountToday++;
        return void message.channel.send(url);
      }
      return;
    }

    // Member insight
    if (looksLikeMemberInsight(text)) {
      const info = await buildMemberInsight(message);
      return void message.reply(info);
    }

    // Magic Eden (simple triggers)
    if (/\b(oukii|magic eden|me)\b.*(stats|floor|listed|sales)/i.test(text) || /^!oukii\b/i.test(text)) {
      const [stats, sales] = await Promise.all([
        fetchMagicEdenStats(CONFIG.MAGIC_EDEN_COLLECTION_SYMBOL),
        fetchMagicEdenActivities24h(CONFIG.MAGIC_EDEN_COLLECTION_SYMBOL),
      ]);
      const floor = stats?.floorPrice || stats?.floor_price || stats?.floor || null;
      const listed = stats?.listedCount ?? stats?.listed ?? null;
      const supply = stats?.supply ?? stats?.totalSupply ?? null;
      const sales24 = sales?.length || 0;

      const embed = new EmbedBuilder()
        .setTitle('OUKII — Magic Eden snapshot')
        .setDescription('Quick stats for the last 24h')
        .addFields(
          { name: 'Floor', value: floor ? String(floor) : '—', inline: true },
          { name: 'Listed', value: listed != null ? String(listed) : '—', inline: true },
          { name: '24h sales', value: String(sales24), inline: true },
          { name: 'Supply (if known)', value: supply != null ? String(supply) : 'Not exposed', inline: true },
        )
        .setFooter({ text: 'Data: Magic Eden' })
        .setTimestamp(new Date());
      return void message.channel.send({ embeds: [embed] });
    }

    // Decide whether to reply
    const chance = isQuestionLike(text) ? CONFIG.REPLY_CHANCE_QUESTION : CONFIG.REPLY_CHANCE;
    if (Math.random() > chance) return;

    // Gather knowledge
    const snippets = await gatherKnowledgeSnippets(message.guild, text);
    const kbBlock = snippets.length ? `\n\nKnowledge:\n- ${snippets.join('\n- ')}` : '';

    // Build prompt
    const userPrompt = `User said: "${text}"${kbBlock}\n\nReply in under 90 words, friendly and cheeky (but kind). Do not mention @here or @everyone.`;

    let aiReply = '';
    if (CONFIG.OPENAI_API_KEY) {
      aiReply = await askAI({ system: SYSTEM_PROMPT, user: userPrompt });
    }

    const safeReply = (aiReply || 'Got you. 👍').replace(/@here|@everyone/g, '').trim();
    if (safeReply) await message.reply(safeReply);
  } catch (e) {
    console.error('Message handler error:', e);
  }
});

// ---------- Login ----------
if (!CONFIG.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in env.');
  process.exit(1);
}
client.login(CONFIG.DISCORD_TOKEN);
