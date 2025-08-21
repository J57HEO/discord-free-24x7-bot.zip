import "dotenv/config";
import { Client, GatewayIntentBits, Partials, ChannelType, Events } from "discord.js";
import fs from "fs";

// --- simple config (doesn't need editing here) ---
const config = {
  language: process.env.LANGUAGE || "en",
  replyChance: Number(process.env.REPLY_CHANCE) || 0.30,
  replyChanceIfQuestion: Number(process.env.REPLY_CHANCE_QUESTION) || 0.85,
  idleMinutesBeforeStarter: Number(process.env.IDLE_MINUTES) || 30,
  starterCooldownMinutes: Number(process.env.STARTER_COOLDOWN_MINUTES) || 45,
};
const DEBUG_ECHO = process.env.DEBUG_ECHO === "1";

// allowlist: comma-separated; empty => allow all non-NSFW text channels
const allowlist = (process.env.CHANNEL_NAME_ALLOWLIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const allowlistSet = new Set(allowlist);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

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

// Minimal “AI” that just returns empty; we’ll fall back to a cheeky line.
// (Your real AI runs in another file; for diagnostics we don’t need it.)
async function fakeAIReply(prompt) {
  return ""; // force fallback so you always see something
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const [, guild] of client.guilds.cache) {
    const list = guild.channels.cache
      .filter(allowedChannel)
      .map(ch => `#${ch.name} (${ch.id})`)
      .join(", ");
    console.log(`[ALLOWED in ${guild.name}]`, list || "(none)");
  }
});

// Always echo (parrot) when DEBUG_ECHO=1, otherwise behave with chances
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!allowedChannel(message.channel)) return;
    if (!canSendInChannel(message.channel)) {
      console.warn("[SKIP] missing perms in channel:", message.channel?.name);
      return;
    }

    console.log("[MSG]", {
      guild: message.guild?.name,
      channel: message.channel?.name,
      content: message.content?.slice(0, 80)
    });

    // PARROT MODE: reply to every message deterministically
    if (DEBUG_ECHO) {
      await message.channel.send({
        content: `ECHO: ${message.content || "(no text)"}`,
        allowedMentions: { parse: [] }
      });
      return;
    }

    // Normal behaviour (30% of messages / 85% if question)
    const txt = message.content?.trim() || "";
    const isQuestion = /\?$/.test(txt) || /\b(why|how|what|where|who|when)\b/i.test(txt);
    const chance = isQuestion ? config.replyChanceIfQuestion : config.replyChance;
    if (Math.random() > chance && !message.mentions.has(client.user)) return;

    await message.channel.sendTyping();

    // “Fake AI”: we return empty, then fall back to cheeky line
    let out =
