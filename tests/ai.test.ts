import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, upsertConnection } from "../src/lib/db.js";
import { runAnalysis } from "../src/lib/ai.js";
import { loadConfig } from "../src/lib/config.js";
import type { Connection } from "../src/types.js";

const TEST_HOME = join(tmpdir(), "wirewatch-test-ai");
const TEST_DB = join(TEST_HOME, "test.db");

function makeConnection(overrides: Partial<Omit<Connection, "id">> = {}): Omit<Connection, "id"> {
  const now = Date.now();
  return {
    protocol: "tcp",
    src_ip: "192.168.1.5",
    src_port: 52345,
    dst_ip: "8.8.8.8",
    dst_port: 443,
    dst_hostname: null,
    country_code: "US",
    direction: "outbound",
    state: "ESTABLISHED",
    process_name: "Chrome",
    process_pid: 1234,
    bytes_sent: null,
    bytes_recv: null,
    interface: "en0",
    capture_mode: "passive",
    first_seen: now,
    last_seen: now,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.WIREWATCH_HOME = TEST_HOME;
  mkdirSync(TEST_HOME, { recursive: true });
  getDb(TEST_DB);
});

afterEach(() => {
  closeDb();
  delete process.env.WIREWATCH_HOME;
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
});

describe("runAnalysis", () => {
  it("throws when no API key is set", async () => {
    upsertConnection(makeConnection());
    const config = loadConfig();
    config.ai.anthropic.apiKey = "";
    config.ai.openai.apiKey = "";
    await expect(runAnalysis(config)).rejects.toThrow(/No API key/);
  });

  it("throws when no connections to analyze", async () => {
    const config = loadConfig();
    config.ai.anthropic.apiKey = "sk-ant-test";
    await expect(runAnalysis(config)).rejects.toThrow(/No new connections/);
  });

  it("uses openai provider when configured", async () => {
    upsertConnection(makeConnection());
    const config = loadConfig();
    config.ai.provider = "openai";
    config.ai.openai.apiKey = "";
    await expect(runAnalysis(config)).rejects.toThrow(/No API key/);
  });
});
