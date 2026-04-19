import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { promisify } from "node:util";
import type { Connection } from "../../types.js";

export type RawConnection = Omit<Connection, "id">;

const execFileAsync = promisify(execFile);

const LINUX_TCP_STATES: Record<string, string> = {
  "01": "ESTABLISHED",
  "02": "SYN_SENT",
  "03": "SYN_RECV",
  "04": "FIN_WAIT1",
  "05": "FIN_WAIT2",
  "06": "TIME_WAIT",
  "07": "CLOSE",
  "08": "CLOSE_WAIT",
  "09": "LAST_ACK",
  "0A": "LISTEN",
  "0B": "CLOSING",
};

// -- Linux helpers --

function hexToIpv4(hex: string): string {
  const n = parseInt(hex, 16);
  return [(n & 0xff), (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff].join(".");
}

function hexToIpv6(hex: string): string {
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 8) {
    const chunk = hex.slice(i, i + 8);
    const reversed = (chunk.match(/../g) ?? []).reverse().join("");
    groups.push(reversed.slice(0, 4), reversed.slice(4, 8));
  }
  return groups.join(":").replace(/\b0+([0-9a-f])/g, "$1");
}

function buildInodeMap(): Map<string, { name: string; pid: number }> {
  const map = new Map<string, { name: string; pid: number }>();
  try {
    const pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    for (const pid of pids) {
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
        const fds = readdirSync(`/proc/${pid}/fd`);
        for (const fd of fds) {
          try {
            const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
            const m = link.match(/^socket:\[(\d+)\]$/);
            if (m) map.set(m[1], { name: comm, pid: Number(pid) });
          } catch {
            // fd disappeared between readdir and readlink
          }
        }
      } catch {
        // process disappeared
      }
    }
  } catch {
    // /proc unavailable
  }
  return map;
}

function parseProcNetFile(
  path: string,
  protocol: string,
  isIpv6: boolean,
  inodeMap: Map<string, { name: string; pid: number }>,
  now: number,
): RawConnection[] {
  const results: RawConnection[] = [];
  try {
    const lines = readFileSync(path, "utf-8").split("\n").slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;

      const [localHex, remHex] = [parts[1], parts[2]];
      const stateHex = parts[3].toUpperCase();
      const inode = parts[9];

      const [localAddrHex, localPortHex] = localHex.split(":");
      const [remAddrHex, remPortHex] = remHex.split(":");

      if (!localAddrHex || !localPortHex || !remAddrHex || !remPortHex) continue;

      const src_ip = isIpv6 ? hexToIpv6(localAddrHex) : hexToIpv4(localAddrHex);
      const dst_ip = isIpv6 ? hexToIpv6(remAddrHex) : hexToIpv4(remAddrHex);
      const src_port = parseInt(localPortHex, 16);
      const dst_port = parseInt(remPortHex, 16);
      const state = LINUX_TCP_STATES[stateHex] ?? stateHex;

      if (dst_ip === "0.0.0.0" || dst_ip === ":") continue;

      const proc = inodeMap.get(inode);

      results.push({
        protocol,
        src_ip,
        src_port,
        dst_ip,
        dst_port,
        dst_hostname: null,
        country_code: null,
        direction: "outbound",
        state,
        process_name: proc?.name ?? null,
        process_pid: proc?.pid ?? null,
        bytes_sent: null,
        bytes_recv: null,
        interface: null,
        capture_mode: "passive",
        first_seen: now,
        last_seen: now,
      });
    }
  } catch {
    // file missing or unreadable
  }
  return results;
}

function snapshotLinux(now: number): RawConnection[] {
  const inodeMap = buildInodeMap();
  return [
    ...parseProcNetFile("/proc/net/tcp", "tcp", false, inodeMap, now),
    ...parseProcNetFile("/proc/net/tcp6", "tcp", true, inodeMap, now),
    ...parseProcNetFile("/proc/net/udp", "udp", false, inodeMap, now),
    ...parseProcNetFile("/proc/net/udp6", "udp", true, inodeMap, now),
  ];
}

// -- macOS helpers --

function parseAddress(raw: string): { ip: string; port: number } | null {
  if (raw === "*") return null;
  const ipv6Match = raw.match(/^\[(.+)\]:(\d+)$/);
  if (ipv6Match) return { ip: ipv6Match[1], port: Number(ipv6Match[2]) };
  const lastDot = raw.lastIndexOf(":");
  if (lastDot === -1) return null;
  return { ip: raw.slice(0, lastDot), port: Number(raw.slice(lastDot + 1)) };
}

async function snapshotMacOs(now: number, lsofTimeout: number): Promise<RawConnection[]> {
  const results: RawConnection[] = [];
  try {
    const { stdout } = await execFileAsync("lsof", ["-i", "-n", "-P"], {
      timeout: lsofTimeout,
    });

    for (const line of stdout.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 9) continue;

      const process_name = cols[0] ?? null;
      const process_pid = cols[1] ? Number(cols[1]) : null;
      const protocol = cols[7]?.toUpperCase();
      const nameField = cols.slice(8).join(" ");

      if (!protocol || (protocol !== "TCP" && protocol !== "UDP")) continue;

      const arrowIdx = nameField.indexOf("->");
      if (arrowIdx === -1) continue;

      const rawSrc = nameField.slice(0, arrowIdx);
      const rawDst = nameField.slice(arrowIdx + 2).replace(/\s+\(\w+\)$/, "");
      const stateMatch = nameField.match(/\((\w+)\)$/);
      const state = stateMatch ? stateMatch[1] : null;

      const src = parseAddress(rawSrc);
      const dst = parseAddress(rawDst);
      if (!src || !dst) continue;

      results.push({
        protocol: protocol.toLowerCase(),
        src_ip: src.ip,
        src_port: src.port,
        dst_ip: dst.ip,
        dst_port: dst.port,
        dst_hostname: null,
        country_code: null,
        direction: "outbound",
        state,
        process_name,
        process_pid,
        bytes_sent: null,
        bytes_recv: null,
        interface: null,
        capture_mode: "passive",
        first_seen: now,
        last_seen: now,
      });
    }
  } catch {
    // lsof unavailable or timed out
  }
  return results;
}

// -- Public API --

export async function getSnapshot(lsofTimeout: number): Promise<RawConnection[]> {
  const now = Date.now();
  if (process.platform === "linux") {
    return snapshotLinux(now);
  }
  return snapshotMacOs(now, lsofTimeout);
}
