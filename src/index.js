import "dotenv/config";
import { Client, GatewayIntentBits, Partials, ChannelType, Events } from "discord.js";
import { chat, makeStarterMsg } from "./ai.js";
import { makeStarter } from "./prompt.js";
import fs from "fs";

const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url)));
const allowlistNames = new Set((process.env.CHANNEL_NAME_ALLOWLIST || (config.channelNameAllowlist || []).join(",")).split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

const meta = new Map(); // channelId -> { lastMessageTs, lastStarterTs }

function allowedChannel(ch) {
  if (!ch) return false;
  if (ch.type !== ChannelType.GuildText) return false;
  if (ch.nsfw) return false;
  if (allowlistNames.size && !allowlistNames.has(ch.name.toLowerCase())) return false;
  return true;
}

function canSendInChannel(ch) {
  try {
    const me = ch.guild?.members?.me;
    const perms = ch.permissionsFor(me);
    return perms?.has(["ViewChannel","SendMessages","ReadMessageHistory"]);
  } catch { return false; }
}

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

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  setInterval(checkIdleAndStartConvos, 60 * 1000).unref();
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!allowedChannel(message.channel)) return;
    markMessage(message.channelId);

    const content = message.content?.trim() || "";
    const isQuestion = /\?$/.test(content) || /\b(why|how|what|where|who|when)\b/i.test(content);
    const chance = isQuestion ? (Number(process.env.REPLY_CHANCE_QUESTION) || 0.85) : (Number(process.env.REPLY_CHANCE) || 0.30);
    if (Math.random() > chance && !message.mentions.has(client.user)) return;

    if (!canSendInChannel(message.channel)) return;
    await message.channel.sendTyping();

    const context = content.slice(0, 800);
    const out = await chat({
      messages: [
        { role: "user", content: `Channel: #${message.channel.name}. Be casual and witty.` },
        { role: "user", content: context }
      ],
      language: process.env.LANGUAGE || "en",
      maxTokens: 280
    });

    let text = (out || "").trim();
    if (!text) {
      console.warn("AI returned empty; using fallback");
      text = "my brain just buffered 🤖💭—say that again?";
    }

    await message.channel.send({ content: text, allowedMentions: { parse: [] } });
  } catch (e) {
    console.error("on message error:", e?.message || e);
  }
});

async function checkIdleAndStartConvos() {
  try {
    const now = Date.now();
    const idleMs = (Number(process.env.IDLE_MINUTES) || 30) * 60 * 1000;
    const cooldownMs = (Number(process.env.STARTER_COOLDOWN_MINUTES) || 45) * 60 * 1000;

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
            const starter = (await makeStarterMsg({ serverName: guild.name, channelName: ch.name })) || makeStarter({ serverName: guild.name, channelName: ch.name });
            const text = (starter || "Alright then… how’s everyone doing?").trim();
            await ch.send({ content: text, allowedMentions: { parse: [] } });
            markStarter(ch.id);
          } catch (e) {
            console.warn("starter failed for channel", ch.id, e?.message || e);
          }
        }
      }
    }
  } catch (e) {
    console.error("idle check error", e);
  }
}

client.login(process.env.DISCORD_TOKEN);
