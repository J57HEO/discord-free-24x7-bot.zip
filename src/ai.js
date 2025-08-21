import OpenAI from "openai";
import { styleGuide } from "./prompt.js";

const baseURL = process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1";
const apiKey = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "";
const model = process.env.MODEL || "deepseek/deepseek-r1:free"; // free route on OpenRouter

export const client = new OpenAI({ apiKey, baseURL });

export async function chat({ messages, temperature = 0.8, maxTokens = 300, language = "en" }) {
  try {
    const sys = process.env.SYSTEM_PERSONA?.trim() || styleGuide;
    const finalMessages = [{ role: "system", content: sys }, ...messages, { role: "system", content: `Keep replies concise. Language: ${language}.` }];

    const res = await client.chat.completions.create({
      model,
      messages: finalMessages,
      temperature,
      max_tokens: maxTokens
    });

    const out = res.choices?.[0]?.message?.content || "";
    return (out || "").trim();
  } catch (err) {
    console.error("AI error:", err?.code || err?.status || err?.message);
    return ""; // return empty so caller can use a friendly fallback
  }
}

export async function makeStarterMsg({ serverName, channelName, language="en" }) {
  const userPrompt = `No one has chatted for a while. Create ONE short cheeky opener for #${channelName} in server "${serverName}". Keep under 50 words and end with a question.`;
  return chat({ messages: [{ role: "user", content: userPrompt }], temperature: 0.9, maxTokens: 120, language });
}
