import { networkInterfaces } from "node:os";
import { resolve4 } from "node:dns/promises";
import { enqueueIp, flushQueue } from "../geo.js";
import { incrementSession, upsertConnection } from "../db.js";
import type { WirewatchConfig, ConnectionDirection } from "../../types.js";
import { startDeepCapture } from "./deep.js";
import { getSnapshot, type RawConnection } from "./passive.js";

type TupleKey = string;

function tupleKey(c: RawConnection): TupleKey {
  return `${c.protocol}:${c.src_ip}:${c.src_port ?? ""}:${c.dst_ip}:${c.dst_port ?? ""}`;
}

function getLocalIps(): Set<string> {
  const ips = new Set<string>();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) ips.add(addr.address);
  }
  return ips;
}

function resolveDirection(
  srcIp: string,
  dstIp: string,
  localIps: Set<string>,
): ConnectionDirection {
  const srcLocal = localIps.has(srcIp);
  const dstLocal = localIps.has(dstIp);
  if (srcLocal && dstLocal) return "local";
  if (srcLocal) return "outbound";
  return "inbound";
}

function writeConnection(conn: RawConnection, sessionId: number, localIps: Set<string>, excludeIps: Set<string>): void {
  if (excludeIps.has(conn.dst_ip)) return;
  const enriched = {
    ...conn,
    direction: resolveDirection(conn.src_ip, conn.dst_ip, localIps),
  };
  upsertConnection(enriched);
  enqueueIp(conn.dst_ip);
  incrementSession(sessionId);
}

export async function startCapture(config: WirewatchConfig, sessionId: number): Promise<() => void> {
  const { mode, interval, interfaces } = config.capture;
  const localIps = getLocalIps();

  const excludeIps = new Set<string>();
  try {
    const geoHost = new URL(config.geo.url).hostname;
    const ips = await resolve4(geoHost);
    for (const ip of ips) excludeIps.add(ip);
  } catch { /* DNS failed or invalid URL */ }

  if (mode === "deep") {
    const stopDeep = startDeepCapture(interfaces, (conn) => {
      writeConnection(conn, sessionId, localIps, excludeIps);
    });

    const geoInterval = setInterval(() => {
      flushQueue(config).catch(() => {});
    }, config.geo.flushInterval);

    return () => {
      stopDeep();
      clearInterval(geoInterval);
    };
  }

  // passive mode — diff-based polling
  let previousSnapshot = new Map<TupleKey, RawConnection>();

  async function poll(): Promise<void> {
    const snapshot = await getSnapshot(config.capture.lsofTimeout);
    const currentMap = new Map(snapshot.map((c) => [tupleKey(c), c]));
    const now = Date.now();

    for (const [key, conn] of currentMap) {
      const prev = previousSnapshot.get(key);
      if (!prev) {
        writeConnection(conn, sessionId, localIps, excludeIps);
      } else if (prev.state !== conn.state) {
        upsertConnection({ ...conn, first_seen: prev.first_seen, last_seen: now });
      }
    }

    previousSnapshot = currentMap;
  }

  const pollInterval = setInterval(() => {
    poll().catch(() => {});
  }, interval * 1000);

  const geoInterval = setInterval(() => {
    flushQueue(config).catch(() => {});
  }, config.geo.flushInterval);

  poll().catch(() => {});

  return () => {
    clearInterval(pollInterval);
    clearInterval(geoInterval);
  };
}
