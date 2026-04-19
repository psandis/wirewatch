import { describe, expect, it } from "vitest";

describe("capture passive — platform detection", () => {
  it("runs on the current platform without throwing", async () => {
    const { getSnapshot } = await import("../src/lib/capture/passive.js");
    await expect(getSnapshot(5000)).resolves.not.toThrow();
  });

  it("returns an array", async () => {
    const { getSnapshot } = await import("../src/lib/capture/passive.js");
    const result = await getSnapshot(5000);
    expect(Array.isArray(result)).toBe(true);
  });

  it("each connection has required fields", async () => {
    const { getSnapshot } = await import("../src/lib/capture/passive.js");
    const results = await getSnapshot(5000);
    for (const conn of results) {
      expect(conn).toHaveProperty("protocol");
      expect(conn).toHaveProperty("src_ip");
      expect(conn).toHaveProperty("dst_ip");
      expect(conn).toHaveProperty("direction");
      expect(conn).toHaveProperty("capture_mode", "passive");
      expect(conn).toHaveProperty("first_seen");
      expect(conn).toHaveProperty("last_seen");
      expect(typeof conn.first_seen).toBe("number");
      expect(typeof conn.last_seen).toBe("number");
    }
  });

  it("returns unix ms timestamps", async () => {
    const { getSnapshot } = await import("../src/lib/capture/passive.js");
    const before = Date.now();
    const results = await getSnapshot(5000);
    const after = Date.now();
    for (const conn of results) {
      expect(conn.first_seen).toBeGreaterThanOrEqual(before - 100);
      expect(conn.last_seen).toBeLessThanOrEqual(after + 100);
    }
  });
});

describe("capture geo — enqueueIp", () => {
  it("ignores private IPs", async () => {
    const { enqueueIp, flushQueue } = await import("../src/lib/geo.js");
    const privateIps = [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
    ];
    for (const ip of privateIps) enqueueIp(ip);
    const mockConfig = {
      geo: { enabled: true, url: "http://never-called", batchSize: 100, timeout: 100, flushInterval: 10000 },
    };
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { called = true; return new Response("[]"); };
    await flushQueue(mockConfig as never);
    globalThis.fetch = originalFetch;
    expect(called).toBe(false);
  });

  it("does not flush when geo.enabled is false", async () => {
    const { enqueueIp, flushQueue } = await import("../src/lib/geo.js");
    enqueueIp("8.8.8.8");
    const mockConfig = {
      geo: { enabled: false, url: "http://never-called", batchSize: 100, timeout: 100, flushInterval: 10000 },
    };
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { called = true; return new Response("[]"); };
    await flushQueue(mockConfig as never);
    globalThis.fetch = originalFetch;
    expect(called).toBe(false);
  });

  it("does not crash on network failure", async () => {
    const { enqueueIp, flushQueue } = await import("../src/lib/geo.js");
    enqueueIp("8.8.8.8");
    const mockConfig = {
      geo: { enabled: true, url: "http://localhost:1", batchSize: 100, timeout: 100, flushInterval: 10000 },
    };
    await expect(flushQueue(mockConfig as never)).resolves.not.toThrow();
  });
});
