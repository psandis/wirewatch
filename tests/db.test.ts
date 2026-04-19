import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDb,
  deleteAllAnalyses,
  deleteAllConnections,
  deleteConnectionById,
  deleteAnalysisById,
  endSession,
  getActiveSession,
  getConnectionById,
  getDb,
  getDbStats,
  incrementSession,
  insertAnalysis,
  pruneConnections,
  queryAnalyses,
  queryConnections,
  startSession,
  updateCountryCode,
  upsertConnection,
} from "../src/lib/db.js";
import type { Connection } from "../src/types.js";

const TEST_HOME = join(tmpdir(), "wirewatch-test-db");
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
    country_code: null,
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

describe("getDb", () => {
  it("initializes and returns a database", () => {
    const db = getDb(TEST_DB);
    expect(db).toBeDefined();
  });

  it("returns the same instance on repeated calls", () => {
    const a = getDb(TEST_DB);
    const b = getDb(TEST_DB);
    expect(a).toBe(b);
  });
});

describe("upsertConnection", () => {
  it("inserts a new connection", () => {
    upsertConnection(makeConnection());
    const results = queryConnections();
    expect(results).toHaveLength(1);
    expect(results[0].dst_ip).toBe("8.8.8.8");
  });

  it("upserts on same 5-tuple — updates last_seen and state", () => {
    const now = Date.now();
    upsertConnection(makeConnection({ first_seen: now, last_seen: now, state: "ESTABLISHED" }));
    upsertConnection(makeConnection({ first_seen: now, last_seen: now + 2000, state: "TIME_WAIT" }));
    const results = queryConnections();
    expect(results).toHaveLength(1);
    expect(results[0].state).toBe("TIME_WAIT");
    expect(results[0].last_seen).toBe(now + 2000);
  });

  it("inserts distinct connections for different dst_ports", () => {
    upsertConnection(makeConnection({ dst_port: 443 }));
    upsertConnection(makeConnection({ dst_port: 80 }));
    expect(queryConnections()).toHaveLength(2);
  });

  it("preserves existing country_code when upsert provides null", () => {
    upsertConnection(makeConnection({ country_code: "US" }));
    upsertConnection(makeConnection({ country_code: null }));
    const results = queryConnections();
    expect(results[0].country_code).toBe("US");
  });
});

describe("updateCountryCode", () => {
  it("sets country_code for matching dst_ip", () => {
    upsertConnection(makeConnection());
    updateCountryCode("8.8.8.8", "US");
    expect(queryConnections()[0].country_code).toBe("US");
  });

  it("does not overwrite an existing country_code", () => {
    upsertConnection(makeConnection({ country_code: "DE" }));
    updateCountryCode("8.8.8.8", "US");
    expect(queryConnections()[0].country_code).toBe("DE");
  });
});

describe("queryConnections", () => {
  beforeEach(() => {
    upsertConnection(makeConnection({ dst_ip: "1.1.1.1", protocol: "tcp", direction: "outbound", process_name: "curl" }));
    upsertConnection(makeConnection({ dst_ip: "2.2.2.2", protocol: "udp", direction: "inbound", process_name: "node" }));
    upsertConnection(makeConnection({ dst_ip: "3.3.3.3", protocol: "tcp", direction: "local", process_name: "curl" }));
  });

  it("returns all connections by default", () => {
    expect(queryConnections()).toHaveLength(3);
  });

  it("filters by protocol", () => {
    expect(queryConnections({ protocol: "udp" })).toHaveLength(1);
  });

  it("filters by dst_ip", () => {
    expect(queryConnections({ dst_ip: "1.1.1.1" })).toHaveLength(1);
  });

  it("filters by direction", () => {
    expect(queryConnections({ direction: "inbound" })).toHaveLength(1);
  });

  it("filters by process_name", () => {
    expect(queryConnections({ process_name: "curl" })).toHaveLength(2);
  });

  it("respects limit", () => {
    expect(queryConnections({ limit: 2 })).toHaveLength(2);
  });

  it("respects offset", () => {
    expect(queryConnections({ limit: 10, offset: 2 })).toHaveLength(1);
  });

  it("filters by since", () => {
    const future = Date.now() + 9999999;
    expect(queryConnections({ since: future })).toHaveLength(0);
  });
});

describe("getConnectionById", () => {
  it("returns connection by id", () => {
    upsertConnection(makeConnection());
    const all = queryConnections();
    const found = getConnectionById(all[0].id);
    expect(found).not.toBeNull();
    expect(found!.dst_ip).toBe("8.8.8.8");
  });

  it("returns null for unknown id", () => {
    expect(getConnectionById(99999)).toBeNull();
  });
});

describe("deleteAllConnections", () => {
  it("removes all records", () => {
    upsertConnection(makeConnection());
    upsertConnection(makeConnection({ dst_port: 80 }));
    deleteAllConnections();
    expect(queryConnections()).toHaveLength(0);
  });
});

describe("deleteConnectionById", () => {
  it("deletes a connection by id", () => {
    upsertConnection(makeConnection());
    const all = queryConnections();
    const deleted = deleteConnectionById(all[0].id);
    expect(deleted).toBe(true);
    expect(queryConnections()).toHaveLength(0);
  });

  it("returns false for unknown id", () => {
    expect(deleteConnectionById(99999)).toBe(false);
  });
});

describe("pruneConnections", () => {
  it("removes records older than retention days", () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    upsertConnection(makeConnection({ first_seen: old, last_seen: old }));
    upsertConnection(makeConnection({ dst_port: 80 }));
    const pruned = pruneConnections(30);
    expect(pruned).toBe(1);
    expect(queryConnections()).toHaveLength(1);
  });

  it("returns 0 when nothing to prune", () => {
    upsertConnection(makeConnection());
    expect(pruneConnections(30)).toBe(0);
  });
});

describe("analyses", () => {
  it("inserts and queries analyses", () => {
    const id = insertAnalysis({
      created_at: Date.now(),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      connection_count: 10,
      summary: "All clear.",
      flags: "[]",
      risk_level: "low",
    });
    expect(id).toBeGreaterThan(0);
    const results = queryAnalyses();
    expect(results).toHaveLength(1);
    expect(results[0].risk_level).toBe("low");
  });

  it("deleteAllAnalyses removes all records", () => {
    insertAnalysis({
      created_at: Date.now(),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      connection_count: 5,
      summary: "Test.",
      flags: "[]",
      risk_level: "medium",
    });
    deleteAllAnalyses();
    expect(queryAnalyses()).toHaveLength(0);
  });

  it("deleteAnalysisById deletes a single analysis", () => {
    const id = insertAnalysis({
      created_at: Date.now(),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      connection_count: 5,
      summary: "Test.",
      flags: "[]",
      risk_level: "low",
    });
    expect(deleteAnalysisById(id)).toBe(true);
    expect(queryAnalyses()).toHaveLength(0);
  });

  it("deleteAnalysisById returns false for unknown id", () => {
    expect(deleteAnalysisById(99999)).toBe(false);
  });
});

describe("sessions", () => {
  it("starts and ends a session", () => {
    const id = startSession("passive");
    expect(id).toBeGreaterThan(0);
    expect(getActiveSession()).not.toBeNull();
    endSession(id);
    expect(getActiveSession()).toBeNull();
  });

  it("incrementSession bumps connection count", () => {
    const id = startSession("passive");
    incrementSession(id);
    incrementSession(id);
    incrementSession(id);
    endSession(id);
    const stats = getDbStats();
    expect(stats.totalSessions).toBe(1);
  });
});

describe("getDbStats", () => {
  it("returns correct totals", () => {
    upsertConnection(makeConnection({ protocol: "tcp", direction: "outbound" }));
    upsertConnection(makeConnection({ dst_port: 80, protocol: "tcp", direction: "outbound" }));
    upsertConnection(makeConnection({ dst_port: 53, protocol: "udp", direction: "outbound" }));
    insertAnalysis({
      created_at: Date.now(),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      connection_count: 3,
      summary: "Test.",
      flags: "[]",
      risk_level: "low",
    });

    const stats = getDbStats();
    expect(stats.totalConnections).toBe(3);
    expect(stats.totalAnalyses).toBe(1);
    expect(stats.byProtocol.some((r) => r.protocol === "tcp")).toBe(true);
    expect(stats.topDestinations.length).toBeGreaterThan(0);
  });
});
