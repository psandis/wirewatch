import chalk from "chalk";
import type { Analysis, Connection, DbStats, RiskLevel, Session, WirewatchConfig } from "../types.js";

// -- Primitives --

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatRiskLevel(level: RiskLevel): string {
  switch (level) {
    case "low":    return chalk.green(`● low`);
    case "medium": return chalk.yellow(`● medium`);
    case "high":   return chalk.red(`● high`);
  }
}

function formatDirection(dir: string): string {
  switch (dir) {
    case "outbound": return chalk.cyan("out");
    case "inbound":  return chalk.yellow("in");
    case "local":    return chalk.gray("local");
    default:         return dir;
  }
}

function formatProtocol(proto: string): string {
  return chalk.bold(proto.toUpperCase());
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

// -- Connection table --

const COL_WIDTHS = {
  id:      6,
  proto:   5,
  src:     22,
  dst:     30,
  dir:     6,
  state:   13,
  process: 16,
  country: 4,
  seen:    19,
};

export function formatConnectionHeader(): string {
  return chalk.dim(
    pad("ID", COL_WIDTHS.id) +
    pad("PROTO", COL_WIDTHS.proto) +
    pad("SOURCE", COL_WIDTHS.src) +
    pad("DESTINATION", COL_WIDTHS.dst) +
    pad("DIR", COL_WIDTHS.dir) +
    pad("STATE", COL_WIDTHS.state) +
    pad("PROCESS", COL_WIDTHS.process) +
    pad("CC", COL_WIDTHS.country) +
    "LAST SEEN",
  );
}

export function formatConnectionRow(conn: Connection): string {
  const src = `${conn.src_ip}:${conn.src_port ?? "*"}`;
  const dstHost = conn.dst_hostname ?? conn.dst_ip;
  const dst = `${dstHost}:${conn.dst_port ?? "*"}`;

  return (
    pad(String(conn.id), COL_WIDTHS.id) +
    pad(formatProtocol(conn.protocol), COL_WIDTHS.proto + 9) +
    pad(src, COL_WIDTHS.src) +
    pad(dst, COL_WIDTHS.dst) +
    pad(formatDirection(conn.direction), COL_WIDTHS.dir + 9) +
    pad(conn.state ?? "-", COL_WIDTHS.state) +
    pad(conn.process_name ?? "-", COL_WIDTHS.process) +
    pad(conn.country_code ?? "-", COL_WIDTHS.country) +
    formatTimestamp(conn.last_seen)
  );
}

export function formatConnectionTable(connections: Connection[]): string {
  if (connections.length === 0) return chalk.dim("No connections found.");
  const rows = [formatConnectionHeader(), ...connections.map(formatConnectionRow)];
  return rows.join("\n");
}

// -- Connection detail --

export function formatConnectionDetail(conn: Connection): string {
  const duration = formatDuration(conn.last_seen - conn.first_seen);
  const lines = [
    chalk.bold(`Connection #${conn.id}`),
    "",
    `  ${chalk.dim("Protocol")}     ${formatProtocol(conn.protocol)}`,
    `  ${chalk.dim("Direction")}    ${formatDirection(conn.direction)}`,
    `  ${chalk.dim("Source")}       ${conn.src_ip}:${conn.src_port ?? "*"}`,
    `  ${chalk.dim("Destination")}  ${conn.dst_ip}:${conn.dst_port ?? "*"}`,
    conn.dst_hostname ? `  ${chalk.dim("Hostname")}     ${conn.dst_hostname}` : null,
    conn.country_code ? `  ${chalk.dim("Country")}      ${conn.country_code}` : null,
    `  ${chalk.dim("State")}        ${conn.state ?? "-"}`,
    `  ${chalk.dim("Process")}      ${conn.process_name ?? "-"}${conn.process_pid ? ` (PID ${conn.process_pid})` : ""}`,
    `  ${chalk.dim("Capture")}      ${conn.capture_mode}`,
    `  ${chalk.dim("Bytes sent")}   ${formatBytes(conn.bytes_sent)}`,
    `  ${chalk.dim("Bytes recv")}   ${formatBytes(conn.bytes_recv)}`,
    `  ${chalk.dim("Interface")}    ${conn.interface ?? "-"}`,
    `  ${chalk.dim("First seen")}   ${formatTimestamp(conn.first_seen)}`,
    `  ${chalk.dim("Last seen")}    ${formatTimestamp(conn.last_seen)}`,
    `  ${chalk.dim("Duration")}     ${duration}`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// -- Analysis --

export function formatAnalysis(analysis: Analysis, flagged: Connection[]): string {
  const flags = JSON.parse(analysis.flags) as number[];
  const lines = [
    `${chalk.bold("Analysis #" + analysis.id)}  ${formatRiskLevel(analysis.risk_level)}`,
    chalk.dim(`${formatTimestamp(analysis.created_at)}  ${analysis.provider}/${analysis.model}  ${analysis.connection_count} connections`),
    "",
    analysis.summary,
  ];

  if (flags.length > 0) {
    lines.push("", chalk.bold("Flagged connections:"));
    for (const conn of flagged) {
      const dst = conn.dst_hostname ?? conn.dst_ip;
      lines.push(`  ${chalk.red("▶")} #${conn.id}  ${conn.protocol.toUpperCase()} → ${dst}:${conn.dst_port ?? "*"}  ${conn.process_name ?? ""}`);
    }
  }

  return lines.join("\n");
}

// -- DB stats --

export function formatDbStats(stats: DbStats): string {
  const lines = [
    chalk.bold("Database Statistics"),
    "",
    `  ${chalk.dim("Connections")}   ${stats.totalConnections.toLocaleString()}`,
    `  ${chalk.dim("Analyses")}      ${stats.totalAnalyses.toLocaleString()}`,
    `  ${chalk.dim("Sessions")}      ${stats.totalSessions.toLocaleString()}`,
    `  ${chalk.dim("Oldest record")} ${stats.oldestConnection ? formatTimestamp(stats.oldestConnection) : "-"}`,
    `  ${chalk.dim("DB size")}       ${formatBytes(stats.dbSizeBytes)}`,
    "",
    chalk.bold("By protocol:"),
    ...stats.byProtocol.map((r) => `  ${pad(r.protocol.toUpperCase(), 8)} ${r.count.toLocaleString()}`),
    "",
    chalk.bold("By direction:"),
    ...stats.byDirection.map((r) => `  ${pad(r.direction, 10)} ${r.count.toLocaleString()}`),
    "",
    chalk.bold("Top destinations:"),
    ...stats.topDestinations.map((r) => {
      const host = r.dst_hostname ?? r.dst_ip;
      return `  ${pad(host, 40)} ${r.count.toLocaleString()}`;
    }),
  ];
  return lines.join("\n");
}

// -- Daemon status --

export function formatStatus(session: Session | null, pidRunning: boolean): string {
  if (!session || !pidRunning) {
    return `${chalk.red("●")} wirewatch daemon is ${chalk.bold("not running")}\n  Run ${chalk.cyan("ww start")} to begin capture.`;
  }

  const duration = formatDuration(Date.now() - session.started_at);
  return [
    `${chalk.green("●")} wirewatch daemon is ${chalk.bold("running")}`,
    `  ${chalk.dim("Mode")}         ${session.capture_mode}`,
    `  ${chalk.dim("Started")}      ${formatTimestamp(session.started_at)}`,
    `  ${chalk.dim("Uptime")}       ${duration}`,
    `  ${chalk.dim("Connections")}  ${session.connection_count.toLocaleString()}`,
  ].join("\n");
}

// -- Config --

export function formatConfig(config: WirewatchConfig): string {
  const lines = [
    chalk.bold("Configuration"),
    "",
    chalk.dim("AI"),
    `  provider       ${config.ai.provider}`,
    `  anthropic.key  ${config.ai.anthropic.apiKey ? chalk.green("set") : chalk.red("not set")}`,
    `  anthropic.model ${config.ai.anthropic.model}`,
    `  openai.key     ${config.ai.openai.apiKey ? chalk.green("set") : chalk.red("not set")}`,
    `  openai.model   ${config.ai.openai.model}`,
    "",
    chalk.dim("Capture"),
    `  mode           ${config.capture.mode}`,
    `  interval       ${config.capture.interval}s`,
    `  interfaces     ${config.capture.interfaces.length > 0 ? config.capture.interfaces.join(", ") : "all"}`,
    "",
    chalk.dim("Storage"),
    `  retentionDays  ${config.storage.retentionDays}`,
    `  dbCacheSize    ${config.storage.dbCacheSize}`,
    "",
    chalk.dim("GeoIP"),
    `  enabled        ${config.geo.enabled}`,
    `  url            ${config.geo.url}`,
    `  batchSize      ${config.geo.batchSize}`,
    `  timeout        ${config.geo.timeout}ms`,
    `  flushInterval  ${config.geo.flushInterval}ms`,
  ];
  return lines.join("\n");
}
