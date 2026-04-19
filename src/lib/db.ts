import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import type {
  Analysis,
  CaptureMode,
  Connection,
  DbStats,
  QueryConnectionsOptions,
  Session,
} from "../types.js";
import { getDbPath } from "./config.js";

let db: Database.Database | null = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS connections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol     TEXT    NOT NULL,
    src_ip       TEXT    NOT NULL,
    src_port     INTEGER,
    dst_ip       TEXT    NOT NULL,
    dst_port     INTEGER,
    dst_hostname TEXT,
    country_code TEXT,
    direction    TEXT    NOT NULL,
    state        TEXT,
    process_name TEXT,
    process_pid  INTEGER,
    bytes_sent   INTEGER,
    bytes_recv   INTEGER,
    interface    TEXT,
    capture_mode TEXT    NOT NULL,
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    UNIQUE (protocol, src_ip, src_port, dst_ip, dst_port)
  );

  CREATE INDEX IF NOT EXISTS idx_conn_dst       ON connections (dst_ip, dst_port);
  CREATE INDEX IF NOT EXISTS idx_conn_first     ON connections (first_seen);
  CREATE INDEX IF NOT EXISTS idx_conn_last      ON connections (last_seen);
  CREATE INDEX IF NOT EXISTS idx_conn_process   ON connections (process_name);
  CREATE INDEX IF NOT EXISTS idx_conn_direction ON connections (direction);
  CREATE INDEX IF NOT EXISTS idx_conn_country   ON connections (country_code);

  CREATE TABLE IF NOT EXISTS analyses (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at       INTEGER NOT NULL,
    provider         TEXT    NOT NULL,
    model            TEXT    NOT NULL,
    connection_count INTEGER NOT NULL,
    summary          TEXT    NOT NULL,
    flags            TEXT    NOT NULL,
    risk_level       TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses (created_at);

  CREATE TABLE IF NOT EXISTS sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at       INTEGER NOT NULL,
    stopped_at       INTEGER,
    capture_mode     TEXT    NOT NULL,
    connection_count INTEGER NOT NULL DEFAULT 0
  );
`;

export function getDb(dbPath?: string): Database.Database {
  if (db) return db;
  db = new Database(dbPath ?? getDbPath());
  const config = loadConfig();
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma(`cache_size = ${config.storage.dbCacheSize}`);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// -- Connections --

export function upsertConnection(conn: Omit<Connection, "id">): void {
  getDb()
    .prepare(
      `INSERT INTO connections (
        protocol, src_ip, src_port, dst_ip, dst_port, dst_hostname, country_code,
        direction, state, process_name, process_pid, bytes_sent, bytes_recv,
        interface, capture_mode, first_seen, last_seen
      ) VALUES (
        @protocol, @src_ip, @src_port, @dst_ip, @dst_port, @dst_hostname, @country_code,
        @direction, @state, @process_name, @process_pid, @bytes_sent, @bytes_recv,
        @interface, @capture_mode, @first_seen, @last_seen
      )
      ON CONFLICT (protocol, src_ip, src_port, dst_ip, dst_port) DO UPDATE SET
        state        = excluded.state,
        dst_hostname = COALESCE(excluded.dst_hostname, dst_hostname),
        country_code = COALESCE(excluded.country_code, country_code),
        bytes_sent   = COALESCE(excluded.bytes_sent, bytes_sent),
        bytes_recv   = COALESCE(excluded.bytes_recv, bytes_recv),
        last_seen    = excluded.last_seen`,
    )
    .run(conn);
}

export function updateCountryCode(dst_ip: string, country_code: string): void {
  getDb()
    .prepare(`UPDATE connections SET country_code = ? WHERE dst_ip = ? AND country_code IS NULL`)
    .run(country_code, dst_ip);
}

export function queryConnections(opts: QueryConnectionsOptions = {}): Connection[] {
  const { limit = 100, offset = 0, since, protocol, dst_ip, direction, process_name } = opts;

  const conditions: string[] = [];
  const params: Record<string, unknown> = { limit, offset };

  if (since !== undefined) {
    conditions.push("last_seen >= @since");
    params.since = since;
  }
  if (protocol) {
    conditions.push("protocol = @protocol");
    params.protocol = protocol;
  }
  if (dst_ip) {
    conditions.push("dst_ip = @dst_ip");
    params.dst_ip = dst_ip;
  }
  if (direction) {
    conditions.push("direction = @direction");
    params.direction = direction;
  }
  if (process_name) {
    conditions.push("process_name = @process_name");
    params.process_name = process_name;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return getDb()
    .prepare(
      `SELECT * FROM connections ${where}
       ORDER BY last_seen DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all(params) as Connection[];
}

export function getConnectionById(id: number): Connection | null {
  return (
    (getDb().prepare(`SELECT * FROM connections WHERE id = ?`).get(id) as Connection | undefined) ??
    null
  );
}

export function getConnectionsSince(since: number): Connection[] {
  return getDb()
    .prepare(`SELECT * FROM connections WHERE first_seen >= ? ORDER BY first_seen ASC`)
    .all(since) as Connection[];
}

export function deleteAllConnections(): void {
  getDb().prepare(`DELETE FROM connections`).run();
}

export function deleteConnectionById(id: number): boolean {
  const result = getDb().prepare(`DELETE FROM connections WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function pruneConnections(retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = getDb()
    .prepare(`DELETE FROM connections WHERE last_seen < ?`)
    .run(cutoff);
  return result.changes;
}

// -- Analyses --

export function insertAnalysis(analysis: Omit<Analysis, "id">): number {
  const result = getDb()
    .prepare(
      `INSERT INTO analyses (created_at, provider, model, connection_count, summary, flags, risk_level)
       VALUES (@created_at, @provider, @model, @connection_count, @summary, @flags, @risk_level)`,
    )
    .run(analysis);
  return result.lastInsertRowid as number;
}

export function queryAnalyses(limit = 20): Analysis[] {
  return getDb()
    .prepare(`SELECT * FROM analyses ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Analysis[];
}

export function deleteAllAnalyses(): void {
  getDb().prepare(`DELETE FROM analyses`).run();
}

export function deleteAnalysisById(id: number): boolean {
  const result = getDb().prepare(`DELETE FROM analyses WHERE id = ?`).run(id);
  return result.changes > 0;
}

// -- Sessions --

export function startSession(capture_mode: CaptureMode): number {
  const result = getDb()
    .prepare(
      `INSERT INTO sessions (started_at, capture_mode, connection_count)
       VALUES (?, ?, 0)`,
    )
    .run(Date.now(), capture_mode);
  return result.lastInsertRowid as number;
}

export function endSession(id: number): void {
  getDb()
    .prepare(`UPDATE sessions SET stopped_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

export function getActiveSession(): Session | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM sessions WHERE stopped_at IS NULL ORDER BY started_at DESC LIMIT 1`)
      .get() as Session | undefined) ?? null
  );
}

export function incrementSession(id: number): void {
  getDb()
    .prepare(`UPDATE sessions SET connection_count = connection_count + 1 WHERE id = ?`)
    .run(id);
}

// -- Stats --

export function getDbStats(): DbStats {
  const d = getDb();
  const dbPath = getDbPath();

  const totalConnections = (
    d.prepare(`SELECT COUNT(*) as n FROM connections`).get() as { n: number }
  ).n;

  const totalAnalyses = (
    d.prepare(`SELECT COUNT(*) as n FROM analyses`).get() as { n: number }
  ).n;

  const totalSessions = (
    d.prepare(`SELECT COUNT(*) as n FROM sessions`).get() as { n: number }
  ).n;

  const oldest = d
    .prepare(`SELECT MIN(first_seen) as ts FROM connections`)
    .get() as { ts: number | null };

  const topDestinations = d
    .prepare(
      `SELECT dst_ip, dst_hostname, COUNT(*) as count
       FROM connections
       GROUP BY dst_ip
       ORDER BY count DESC
       LIMIT 10`,
    )
    .all() as DbStats["topDestinations"];

  const byProtocol = d
    .prepare(
      `SELECT protocol, COUNT(*) as count
       FROM connections
       GROUP BY protocol
       ORDER BY count DESC`,
    )
    .all() as DbStats["byProtocol"];

  const byDirection = d
    .prepare(
      `SELECT direction, COUNT(*) as count
       FROM connections
       GROUP BY direction
       ORDER BY count DESC`,
    )
    .all() as DbStats["byDirection"];

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath).size;
  } catch {
    dbSizeBytes = 0;
  }

  return {
    totalConnections,
    totalAnalyses,
    totalSessions,
    oldestConnection: oldest.ts,
    dbSizeBytes,
    topDestinations,
    byProtocol,
    byDirection,
  };
}
