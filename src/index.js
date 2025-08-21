import "dotenv/config";
import { Client, GatewayIntentBits, Partials, ChannelType, Events } from "discord.js";
import OpenAI from "openai";

// ---------- Config from env (with sensible defaults) ----------
const REPLY_CHANCE = Number(process.env.REPLY_CHANCE) || 0.30;
const REPLY_CHANCE_QUESTION = Number(process.env.REPLY_CHANCE_QUESTION) || 0.85;
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES) || 30;
const STARTER_COOLDOWN_MINUTES = Number(process.env.STARTER_COOLDOWN_MINUTES) || 45;
const LANGUAGE = process.env.LANGUAGE || "en";

// Allowlist: comma-separated list of channel names (case-insensitive).
// Leave empty to allow all non-NSFW text channels.
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

// ---------- OpenAI-compatible client (OpenRouter by default) ----------
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
    return perms?.has(["ViewChannel","SendMessages","ReadMessageHistory"]);
  } catch {
    return false;
  }
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

// ---------- AI reply ----------
async function aiReply(prompt) {
  try {
    const sys = `You are "CheekyBuddy", a friendly, funny, cheeky (but kind) Discord pal.
- UK English, short punchy replies, emojis OK.
- Never say you're an AI. Keep it light, inclusive, and SFW.
- Avoid @here/@everyone. Keep replies under ~90 words.`;

    const res = await aiClient.chat.completions.create({
      model: MODEL,
      temperature: 0.8,
      max_tokens: 280,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt || "Say hi in a fun cheeky way." },
        { role: "system", content: `Keep replies concise. Language: ${LANGUAGE}.` }
      ]
    });

    return res.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.error("AI error:", e?.status || e?.code || e?.message);
    return ""; // fall back handled by caller
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
          await ch.send({ content: text, allowedMentions: { parse: [] } });
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
  setInterval(idleSweep, 60 * 1000).unref(); // check every minute
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

    const prompt = `Channel: #${message.channel.name}. Be casual, witty, and kind.\nUser said: ${content.slice(0, 800)}`;
    let out = await aiReply(prompt);
    if (!out) out = "my brain just buffered 🤖💭—say that again?";

    await message.channel.send({ content: out, allowedMentions: { parse: [] } });
  } catch (e) {
    console.error("on message error:", e?.message || e);
  }
});

client.login(process.env.DISCORD_TOKEN);
