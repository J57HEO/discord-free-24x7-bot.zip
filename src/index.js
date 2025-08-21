import "dotenv/config";
import { Client, GatewayIntentBits, Partials, ChannelType, Events } from "discord.js";

const DEBUG_ECHO = process.env.DEBUG_ECHO === "1";
const allowlist = (process.env.CHANNEL_NAME_ALLOWLIST || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const allowlistSet = new Set(allowlist);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  // List allowed channels at startup
  for (const [, guild] of client.guilds.cache) {
    const list = guild.channels.cache.filter(allowedChannel).map(ch => `#${ch.name} (${ch.id})`).join(", ");
    console.log(`[ALLOWED in ${guild.name}]`, list || "(none)");
  }
  // Heartbeat log every 10s so we know logs are streaming
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!allowedChannel(message.channel)) return;
    if (!canSendInChannel(message.channel)) {
      console.warn("[SKIP] missing perms in channel:", message.channel?.name);
      return;
    }

    // Always echo in debug, so we 100% see a reply without AI
    if (DEBUG_ECHO) {
      await message.channel.send({ content: `ECHO: ${message.content || "(no text)"}`, allowedMentions: { parse: [] } });
      return;
    }

    // Normal (chance-based) fallback if debug off
    const content = (message.content || "").trim();
    const isQuestion = /\?$/.test(content) || /\b(why|how|what|where|who|when)\b/i.test(content);
    const chance = isQuestion ? (Number(process.env.REPLY_CHANCE_QUESTION) || 0.85) : (Number(process.env.REPLY_CHANCE) || 0.30);
    if (Math.random() > chance && !message.mentions.has(client.user)) return;

    await message.channel.sendTyping();
    await message.channel.send({ content: "my brain just buffered 🤖💭—say that again?", allowedMentions: { parse: [] } });
  } catch (e) {
    console.error("on message error:", e?.message || e);
  }
});

client.login(process.env.DISCORD_TOKEN);
