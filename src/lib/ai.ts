import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getConnectionsSince, insertAnalysis, queryAnalyses } from "./db.js";
import type { Connection, RiskLevel, WirewatchConfig } from "../types.js";

const SYSTEM_PROMPT = `You are a network security analyst. You will be given a list of recent network connections from a monitored machine. Analyze them for suspicious or unusual patterns such as:
- Connections to unusual ports (non-standard, high-numbered, known malware ports)
- Unexpected outbound connections to unfamiliar IPs or countries
- High-frequency connections suggesting beaconing or data exfiltration
- Connections from unexpected processes

Respond ONLY with a valid JSON object in this exact format:
{
  "risk_level": "low" | "medium" | "high",
  "summary": "A concise 2-3 sentence summary of the traffic and any concerns.",
  "flags": [array of connection IDs that are suspicious, empty array if none]
}`;

function formatConnections(connections: Connection[]): string {
  return connections
    .map((c) => {
      const proc = c.process_name ? ` [${c.process_name}]` : "";
      const country = c.country_code ? ` (${c.country_code})` : "";
      const bytes =
        c.bytes_sent != null ? ` sent:${c.bytes_sent}B` : "";
      return `ID:${c.id} ${c.protocol.toUpperCase()} ${c.src_ip}:${c.src_port ?? "*"} → ${c.dst_ip}:${c.dst_port ?? "*"}${country} ${c.direction} ${c.state ?? ""}${proc}${bytes}`;
    })
    .join("\n");
}

function parseAiResponse(raw: string): {
  risk_level: RiskLevel;
  summary: string;
  flags: number[];
} {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI response did not contain valid JSON");

  const parsed = JSON.parse(jsonMatch[0]) as {
    risk_level: unknown;
    summary: unknown;
    flags: unknown;
  };

  const validLevels: RiskLevel[] = ["low", "medium", "high"];
  if (!validLevels.includes(parsed.risk_level as RiskLevel)) {
    throw new Error(`Invalid risk_level: ${String(parsed.risk_level)}`);
  }
  if (typeof parsed.summary !== "string") {
    throw new Error("Missing summary in AI response");
  }
  if (!Array.isArray(parsed.flags)) {
    throw new Error("Missing flags array in AI response");
  }

  return {
    risk_level: parsed.risk_level as RiskLevel,
    summary: parsed.summary,
    flags: (parsed.flags as unknown[]).filter((f): f is number => typeof f === "number"),
  };
}

async function callAnthropic(
  config: WirewatchConfig,
  userMessage: string,
): Promise<string> {
  const client = new Anthropic({ apiKey: config.ai.anthropic.apiKey });
  const msg = await client.messages.create({
    model: config.ai.anthropic.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const block = msg.content[0];
  if (block?.type !== "text") throw new Error("Unexpected Anthropic response type");
  return block.text;
}

async function callOpenAi(
  config: WirewatchConfig,
  userMessage: string,
): Promise<string> {
  const client = new OpenAI({ apiKey: config.ai.openai.apiKey });
  const res = await client.chat.completions.create({
    model: config.ai.openai.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });
  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error("Empty OpenAI response");
  return content;
}

export async function runAnalysis(config: WirewatchConfig): Promise<number> {
  const provider = config.ai.provider;
  const apiKey =
    provider === "anthropic" ? config.ai.anthropic.apiKey : config.ai.openai.apiKey;

  if (!apiKey) {
    throw new Error(
      `No API key set for ${provider}. Run: ww config set ai.${provider}.apiKey <key>`,
    );
  }

  const lastAnalysis = queryAnalyses(1)[0];
  const since = lastAnalysis ? lastAnalysis.created_at : Date.now() - 24 * 60 * 60 * 1000;
  const connections = getConnectionsSince(since);

  if (connections.length === 0) {
    throw new Error("No new connections to analyze since last run.");
  }

  const userMessage = `Analyze these ${connections.length} network connections:\n\n${formatConnections(connections)}`;

  const raw =
    provider === "anthropic"
      ? await callAnthropic(config, userMessage)
      : await callOpenAi(config, userMessage);

  const { risk_level, summary, flags } = parseAiResponse(raw);

  const model =
    provider === "anthropic" ? config.ai.anthropic.model : config.ai.openai.model;

  return insertAnalysis({
    created_at: Date.now(),
    provider,
    model,
    connection_count: connections.length,
    summary,
    flags: JSON.stringify(flags),
    risk_level,
  });
}
