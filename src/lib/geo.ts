import { updateCountryCode } from "./db.js";
import type { WirewatchConfig } from "../types.js";

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
];

const queue = new Set<string>();

function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

export function enqueueIp(ip: string): void {
  if (!isPrivateIp(ip)) {
    queue.add(ip);
  }
}

export async function flushQueue(config: WirewatchConfig): Promise<void> {
  if (!config.geo.enabled || queue.size === 0) return;

  const batch = [...queue].slice(0, config.geo.batchSize);
  for (const ip of batch) queue.delete(ip);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.geo.timeout);

    const res = await fetch(config.geo.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch.map((query) => ({ query, fields: "status,countryCode" }))),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) return;

    const results = (await res.json()) as Array<{
      status: string;
      countryCode: string;
      query: string;
    }>;

    for (const result of results) {
      if (result.status === "success" && result.countryCode) {
        updateCountryCode(result.query, result.countryCode);
      }
    }
  } catch {
    // network error, timeout, rate limit, parse failure — silent, never crashes
  }
}
