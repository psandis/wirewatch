import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getHome, getPidPath } from "./lib/config.js";
import { getDb, closeDb, startSession, endSession, pruneConnections } from "./lib/db.js";
import { startCapture } from "./lib/capture/index.js";

function logPath(): string {
  return join(getHome(), "daemon.log");
}

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(logPath(), line);
  } catch {
    // log write failed — ignore
  }
}

function writePid(): void {
  writeFileSync(getPidPath(), String(process.pid), "utf-8");
}

function removePid(): void {
  try {
    import("node:fs").then(({ unlinkSync }) => unlinkSync(getPidPath())).catch(() => {});
  } catch {
    // already removed
  }
}

let sessionId: number | null = null;
let stopCapture: (() => void) | null = null;

function shutdown(signal: string): void {
  log(`Received ${signal}. Shutting down.`);
  if (stopCapture) stopCapture();
  if (sessionId !== null) {
    try {
      endSession(sessionId);
    } catch {
      // db may already be closing
    }
  }
  closeDb();
  removePid();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${String(reason)}`);
});

async function main(): Promise<void> {
  const config = loadConfig();

  writePid();
  log(`Started. PID=${process.pid} mode=${config.capture.mode}`);

  getDb();

  const pruned = pruneConnections(config.storage.retentionDays);
  if (pruned > 0) log(`Pruned ${pruned} expired connections.`);

  sessionId = startSession(config.capture.mode);
  stopCapture = await startCapture(config, sessionId);

  log("Capture running.");
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  removePid();
  process.exit(1);
});
