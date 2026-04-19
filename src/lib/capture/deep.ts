import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Connection } from "../../types.js";
import type { RawConnection } from "./passive.js";

function splitAddressPort(raw: string): { ip: string; port: number } | null {
  const lastDot = raw.lastIndexOf(".");
  if (lastDot === -1) return null;
  const port = Number(raw.slice(lastDot + 1));
  if (Number.isNaN(port)) return null;
  return { ip: raw.slice(0, lastDot), port };
}

function parseTcpdumpLine(line: string, now: number): RawConnection | null {
  const ipv4 = line.match(/IP\s+(\S+)\s+>\s+(\S+?):\s+(tcp|udp)\s+(\d+)/i);
  if (ipv4) {
    const src = splitAddressPort(ipv4[1]);
    const dst = splitAddressPort(ipv4[2].replace(/:$/, ""));
    if (!src || !dst) return null;

    const bytes = Number(ipv4[4]);
    const protocol = ipv4[3].toLowerCase();

    return {
      protocol,
      src_ip: src.ip,
      src_port: src.port,
      dst_ip: dst.ip,
      dst_port: dst.port,
      dst_hostname: null,
      country_code: null,
      direction: "outbound",
      state: protocol === "tcp" ? "ESTABLISHED" : null,
      process_name: null,
      process_pid: null,
      bytes_sent: bytes,
      bytes_recv: null,
      interface: null,
      capture_mode: "deep",
      first_seen: now,
      last_seen: now,
    };
  }
  return null;
}

export function startDeepCapture(
  interfaces: string[],
  onPacket: (conn: RawConnection) => void,
): () => void {
  const args = ["-l", "-n", "-q", "-tttt"];

  if (interfaces.length > 0) {
    args.push("-i", interfaces[0]);
  }

  let proc: ChildProcess | null = spawn("tcpdump", args, {
    stdio: ["ignore", "pipe", "ignore"],
  });

  proc.stdout?.setEncoding("utf-8");

  let buffer = "";
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    const now = Date.now();
    for (const line of lines) {
      const conn = parseTcpdumpLine(line, now);
      if (conn) onPacket(conn);
    }
  });

  proc.on("error", () => {
    // tcpdump not available or permission denied — silent
  });

  return () => {
    if (proc) {
      proc.kill("SIGTERM");
      proc = null;
    }
  };
}
