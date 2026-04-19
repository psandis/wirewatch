import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AiProvider, CaptureMode, WirewatchConfig } from "../types.js";

const DEFAULT_CONFIG: WirewatchConfig = {
  ai: {
    provider: "anthropic",
    anthropic: { apiKey: "", model: "claude-haiku-4-5-20251001" },
    openai: { apiKey: "", model: "gpt-4o-mini" },
  },
  capture: {
    interval: 2,
    mode: "passive",
    interfaces: [],
    lsofTimeout: 5000,
  },
  storage: {
    retentionDays: 30,
    dbCacheSize: -8000,
  },
  geo: {
    enabled: true,
    url: "http://ip-api.com/batch",
    batchSize: 100,
    timeout: 3000,
    flushInterval: 10000,
  },
};

const VALID_PROVIDERS: AiProvider[] = ["anthropic", "openai"];
const VALID_MODES: CaptureMode[] = ["passive", "deep"];

export function getHome(): string {
  return process.env.WIREWATCH_HOME ?? join(homedir(), ".wirewatch");
}

export function getConfigPath(): string {
  return join(getHome(), "config.json");
}

export function getDbPath(): string {
  return join(getHome(), "wirewatch.db");
}

export function getPidPath(): string {
  return join(getHome(), "wirewatch.pid");
}

function ensureHome(): void {
  const home = getHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }
}

function mergeConfig(defaults: WirewatchConfig, partial: Partial<WirewatchConfig>): WirewatchConfig {
  return {
    ai: {
      ...defaults.ai,
      ...partial.ai,
      anthropic: { ...defaults.ai.anthropic, ...partial.ai?.anthropic },
      openai: { ...defaults.ai.openai, ...partial.ai?.openai },
    },
    capture: { ...defaults.capture, ...partial.capture },
    storage: { ...defaults.storage, ...partial.storage },
    geo: { ...defaults.geo, ...partial.geo },
  };
}

export function loadConfig(): WirewatchConfig {
  ensureHome();
  const path = getConfigPath();
  if (!existsSync(path)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<WirewatchConfig>;
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config: WirewatchConfig): void {
  ensureHome();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function setConfigValue(config: WirewatchConfig, key: string, value: string): WirewatchConfig {
  const updated = structuredClone(config);

  switch (key) {
    case "ai.provider": {
      if (!VALID_PROVIDERS.includes(value as AiProvider)) {
        throw new Error(`Invalid provider "${value}". Valid options: ${VALID_PROVIDERS.join(", ")}`);
      }
      updated.ai.provider = value as AiProvider;
      break;
    }
    case "ai.anthropic.apiKey":
      updated.ai.anthropic.apiKey = value;
      break;
    case "ai.anthropic.model":
      updated.ai.anthropic.model = value;
      break;
    case "ai.openai.apiKey":
      updated.ai.openai.apiKey = value;
      break;
    case "ai.openai.model":
      updated.ai.openai.model = value;
      break;
    case "capture.interval": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`capture.interval must be a positive integer`);
      updated.capture.interval = n;
      break;
    }
    case "capture.mode": {
      if (!VALID_MODES.includes(value as CaptureMode)) {
        throw new Error(`Invalid mode "${value}". Valid options: ${VALID_MODES.join(", ")}`);
      }
      updated.capture.mode = value as CaptureMode;
      break;
    }
    case "capture.lsofTimeout": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`capture.lsofTimeout must be a positive integer`);
      updated.capture.lsofTimeout = n;
      break;
    }
    case "storage.retentionDays": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`storage.retentionDays must be a positive integer`);
      updated.storage.retentionDays = n;
      break;
    }
    case "storage.dbCacheSize": {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new Error(`storage.dbCacheSize must be an integer`);
      updated.storage.dbCacheSize = n;
      break;
    }
    case "geo.enabled":
      if (value !== "true" && value !== "false") throw new Error(`geo.enabled must be true or false`);
      updated.geo.enabled = value === "true";
      break;
    case "geo.url":
      if (!value.startsWith("http")) throw new Error(`geo.url must be a valid URL`);
      updated.geo.url = value;
      break;
    case "geo.batchSize": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`geo.batchSize must be between 1 and 100`);
      updated.geo.batchSize = n;
      break;
    }
    case "geo.timeout": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`geo.timeout must be a positive integer`);
      updated.geo.timeout = n;
      break;
    }
    case "geo.flushInterval": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1000) throw new Error(`geo.flushInterval must be at least 1000ms`);
      updated.geo.flushInterval = n;
      break;
    }
    default:
      throw new Error(`Unknown config key "${key}". Run "ww config show" to see available keys.`);
  }

  return updated;
}

export function maskConfig(config: WirewatchConfig): WirewatchConfig {
  const masked = structuredClone(config);
  if (masked.ai.anthropic.apiKey) masked.ai.anthropic.apiKey = "sk-ant-***";
  if (masked.ai.openai.apiKey) masked.ai.openai.apiKey = "sk-***";
  return masked;
}
