import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfigPath,
  getDbPath,
  getPidPath,
  loadConfig,
  maskConfig,
  saveConfig,
  setConfigValue,
} from "../src/lib/config.js";

const TEST_HOME = join(tmpdir(), "wirewatch-test-config");

beforeEach(() => {
  process.env.WIREWATCH_HOME = TEST_HOME;
});

afterEach(() => {
  delete process.env.WIREWATCH_HOME;
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
});

describe("paths", () => {
  it("respects WIREWATCH_HOME", () => {
    expect(getConfigPath()).toBe(join(TEST_HOME, "config.json"));
    expect(getDbPath()).toBe(join(TEST_HOME, "wirewatch.db"));
    expect(getPidPath()).toBe(join(TEST_HOME, "wirewatch.pid"));
  });
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig();
    expect(config.ai.provider).toBe("anthropic");
    expect(config.capture.mode).toBe("passive");
    expect(config.capture.interval).toBe(2);
    expect(config.storage.retentionDays).toBe(30);
    expect(config.geo.enabled).toBe(true);
    expect(config.geo.batchSize).toBe(100);
  });

  it("creates home directory on first load", () => {
    loadConfig();
    expect(existsSync(TEST_HOME)).toBe(true);
  });

  it("merges partial config with defaults", () => {
    const partial = { ai: { provider: "openai" as const } };
    saveConfig({ ...loadConfig(), ...partial });
    const loaded = loadConfig();
    expect(loaded.ai.provider).toBe("openai");
    expect(loaded.capture.interval).toBe(2);
  });

  it("returns defaults if config file is corrupt", () => {
    loadConfig();
    const { writeFileSync } = require("node:fs");
    writeFileSync(getConfigPath(), "not valid json");
    const config = loadConfig();
    expect(config.ai.provider).toBe("anthropic");
  });
});

describe("saveConfig / loadConfig roundtrip", () => {
  it("persists and reloads all fields", () => {
    const config = loadConfig();
    config.ai.anthropic.apiKey = "sk-ant-test";
    config.capture.interval = 5;
    config.geo.timeout = 5000;
    saveConfig(config);

    const loaded = loadConfig();
    expect(loaded.ai.anthropic.apiKey).toBe("sk-ant-test");
    expect(loaded.capture.interval).toBe(5);
    expect(loaded.geo.timeout).toBe(5000);
  });
});

describe("setConfigValue", () => {
  it("sets ai.provider", () => {
    const config = loadConfig();
    const updated = setConfigValue(config, "ai.provider", "openai");
    expect(updated.ai.provider).toBe("openai");
  });

  it("rejects invalid ai.provider", () => {
    expect(() => setConfigValue(loadConfig(), "ai.provider", "gemini")).toThrow();
  });

  it("sets capture.interval", () => {
    const updated = setConfigValue(loadConfig(), "capture.interval", "10");
    expect(updated.capture.interval).toBe(10);
  });

  it("rejects non-integer capture.interval", () => {
    expect(() => setConfigValue(loadConfig(), "capture.interval", "abc")).toThrow();
    expect(() => setConfigValue(loadConfig(), "capture.interval", "0")).toThrow();
  });

  it("sets capture.mode", () => {
    const updated = setConfigValue(loadConfig(), "capture.mode", "deep");
    expect(updated.capture.mode).toBe("deep");
  });

  it("rejects invalid capture.mode", () => {
    expect(() => setConfigValue(loadConfig(), "capture.mode", "turbo")).toThrow();
  });

  it("sets geo.enabled", () => {
    const updated = setConfigValue(loadConfig(), "geo.enabled", "false");
    expect(updated.geo.enabled).toBe(false);
  });

  it("rejects invalid geo.enabled", () => {
    expect(() => setConfigValue(loadConfig(), "geo.enabled", "yes")).toThrow();
  });

  it("sets geo.url", () => {
    const updated = setConfigValue(loadConfig(), "geo.url", "http://example.com/batch");
    expect(updated.geo.url).toBe("http://example.com/batch");
  });

  it("rejects invalid geo.url", () => {
    expect(() => setConfigValue(loadConfig(), "geo.url", "not-a-url")).toThrow();
  });

  it("sets geo.batchSize within range", () => {
    const updated = setConfigValue(loadConfig(), "geo.batchSize", "50");
    expect(updated.geo.batchSize).toBe(50);
  });

  it("rejects geo.batchSize > 100", () => {
    expect(() => setConfigValue(loadConfig(), "geo.batchSize", "101")).toThrow();
  });

  it("sets storage.retentionDays", () => {
    const updated = setConfigValue(loadConfig(), "storage.retentionDays", "60");
    expect(updated.storage.retentionDays).toBe(60);
  });

  it("sets storage.dbCacheSize", () => {
    const updated = setConfigValue(loadConfig(), "storage.dbCacheSize", "-16000");
    expect(updated.storage.dbCacheSize).toBe(-16000);
  });

  it("rejects unknown keys", () => {
    expect(() => setConfigValue(loadConfig(), "unknown.key", "value")).toThrow();
  });

  it("does not mutate original config", () => {
    const config = loadConfig();
    setConfigValue(config, "capture.interval", "99");
    expect(config.capture.interval).toBe(2);
  });
});

describe("maskConfig", () => {
  it("masks set API keys", () => {
    const config = loadConfig();
    config.ai.anthropic.apiKey = "sk-ant-realkey";
    config.ai.openai.apiKey = "sk-realkey";
    const masked = maskConfig(config);
    expect(masked.ai.anthropic.apiKey).toBe("sk-ant-***");
    expect(masked.ai.openai.apiKey).toBe("sk-***");
  });

  it("leaves empty API keys untouched", () => {
    const config = loadConfig();
    const masked = maskConfig(config);
    expect(masked.ai.anthropic.apiKey).toBe("");
    expect(masked.ai.openai.apiKey).toBe("");
  });
});
