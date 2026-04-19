#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  loadConfig,
  saveConfig,
  setConfigValue,
  getHome,
  getPidPath,
} from "./lib/config.js";
import {
  getDb,
  closeDb,
  queryConnections,
  getConnectionById,
  deleteConnectionById,
  deleteAnalysisById,
  pruneConnections,
  queryAnalyses,
  getActiveSession,
  getDbStats,
} from "./lib/db.js";
import chalk from "chalk";
import { runAnalysis } from "./lib/ai.js";
import {
  formatConnectionTable,
  formatConnectionDetail,
  formatAnalysis,
  formatDbStats,
  formatStatus,
  formatConfig,
} from "./lib/format.js";
import type { ConnectionDirection } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
) as { version: string };

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    return parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  } catch {
    return null;
  }
}

const program = new Command()
  .name("ww")
  .description("Network traffic monitor. Captures connections, stores them locally, and runs AI analysis to flag suspicious activity.")
  .version(version);

// -- start --

program
  .command("start")
  .description("Start the background capture daemon. Begins recording connections immediately. Run \"ww status\" to confirm it is running.")
  .action(() => {
    const pid = readPid();
    if (pid && isPidRunning(pid)) {
      console.log(`Daemon already running (PID ${pid}). Run "ww stop" first.`);
      process.exit(1);
    }

    const daemonPath = join(__dirname, "daemon.js");
    if (!existsSync(daemonPath)) {
      console.error(`Daemon binary not found at ${daemonPath}. Run "pnpm build" first.`);
      process.exit(1);
    }

    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    console.log(`Daemon started (PID ${child.pid}). Run "ww status" to confirm.`);
  });

// -- stop --

program
  .command("stop")
  .description("Stop the background capture daemon. Connections captured during the session remain in the database.")
  .action(() => {
    const pid = readPid();
    if (!pid || !isPidRunning(pid)) {
      console.log("Daemon is not running.");
      try { unlinkSync(getPidPath()); } catch { /* already gone */ }
      process.exit(0);
    }

    process.kill(pid, "SIGTERM");
    console.log(`Daemon stopped (PID ${pid}).`);
  });

// -- status --

program
  .command("status")
  .description("Show whether the daemon is running, how long it has been up, and how many connections have been captured.")
  .action(() => {
    getDb();
    const pid = readPid();
    const running = pid !== null && isPidRunning(pid);
    const session = getActiveSession();
    console.log(formatStatus(session, running));
    closeDb();
  });

// -- monitor --

program
  .command("monitor")
  .description("Open a live connection view that refreshes as the daemon captures. The daemon must be running.")
  .action(async () => {
    const { renderDashboard } = await import("./lib/tui/index.js");
    renderDashboard();
  });

// -- list --

program
  .command("list")
  .description("List captured connections from the database. Use filters to narrow results by protocol, destination, direction, or process.")
  .option("-l, --limit <n>", "Max results", "100")
  .option("-p, --protocol <proto>", "Filter by protocol (tcp, udp)")
  .option("-d, --dst <ip>", "Filter by destination IP")
  .option("--direction <dir>", "Filter by direction (inbound, outbound, local)")
  .option("--process <name>", "Filter by process name")
  .option("--since <ms>", "Show connections since timestamp (unix ms)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    getDb();
    const connections = queryConnections({
      limit: parseInt(opts.limit, 10),
      protocol: opts.protocol,
      dst_ip: opts.dst,
      direction: opts.direction as ConnectionDirection | undefined,
      process_name: opts.process,
      since: opts.since ? parseInt(opts.since, 10) : undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(connections, null, 2));
    } else {
      console.log(formatConnectionTable(connections));
    }
    closeDb();
  });

// -- show --

program
  .command("show <id>")
  .description("Show full detail for a single connection by its ID. Use \"ww list\" to find the ID.")
  .option("--json", "Output as JSON")
  .action((id: string, opts) => {
    getDb();
    const conn = getConnectionById(parseInt(id, 10));
    if (!conn) {
      console.error(`Connection #${id} not found.`);
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(conn, null, 2));
    } else {
      console.log(formatConnectionDetail(conn));
    }
    closeDb();
  });

// -- analyze --

program
  .command("analyze")
  .description("Send recent connections to AI for analysis. Returns a risk level and plain-language summary. Only analyzes connections since the last run. Requires an API key set via \"ww config set\".")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    getDb();
    const config = loadConfig();
    try {
      const analysisId = await runAnalysis(config);
      const analyses = queryAnalyses(1);
      const analysis = analyses[0];
      if (!analysis) throw new Error("Analysis not found after insert.");

      const flags = JSON.parse(analysis.flags) as number[];
      const flagged = flags
        .map((id) => getConnectionById(id))
        .filter((c): c is NonNullable<typeof c> => c !== null);

      if (opts.json) {
        console.log(JSON.stringify({ ...analysis, flagged }, null, 2));
      } else {
        console.log(formatAnalysis(analysis, flagged));
      }
      void analysisId;
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    closeDb();
  });

// -- analyses --

program
  .command("analyses")
  .description("List past AI analyses. Shows risk level, model, connection count, and summary for each run.")
  .option("-l, --limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action((opts) => {
    getDb();
    const analyses = queryAnalyses(parseInt(opts.limit, 10));
    if (opts.json) {
      console.log(JSON.stringify(analyses, null, 2));
    } else {
      if (analyses.length === 0) {
        console.log(chalk.dim("No analyses found. Run \"ww analyze\" first."));
      } else {
        for (const analysis of analyses) {
          const flagged = (JSON.parse(analysis.flags) as number[])
            .map((id) => getConnectionById(id))
            .filter((c): c is NonNullable<typeof c> => c !== null);
          console.log(formatAnalysis(analysis, flagged));
          console.log();
        }
      }
    }
    closeDb();
  });

// -- delete --

program
  .command("delete [id]")
  .description("Delete a connection by ID, a single analysis, prune old records, or wipe all data. Use --all to remove everything including the ~/.wirewatch directory.")
  .option("--analysis <id>", "Delete a single analysis by ID")
  .option("--all", "Delete all data and remove the ~/.wirewatch directory")
  .option("--prune", "Prune connections older than retentionDays")
  .action(async (id, opts) => {
    if (opts.all) {
      const pid = readPid();
      if (pid && isPidRunning(pid)) {
        console.error("Stop the daemon first: ww stop");
        process.exit(1);
      }
      const { rm } = await import("node:fs/promises");
      await rm(getHome(), { recursive: true, force: true });
      console.log(`Deleted all data and removed ${getHome()}`);
      return;
    }
    getDb();
    if (opts.prune) {
      const config = loadConfig();
      const pruned = pruneConnections(config.storage.retentionDays);
      console.log(`Pruned ${pruned} connections older than ${config.storage.retentionDays} days.`);
    } else if (opts.analysis) {
      const deleted = deleteAnalysisById(Number(opts.analysis));
      if (deleted) {
        console.log(`Analysis #${opts.analysis} deleted.`);
      } else {
        console.error(`Analysis #${opts.analysis} not found.`);
        process.exit(1);
      }
    } else if (id) {
      const deleted = deleteConnectionById(Number(id));
      if (deleted) {
        console.log(`Connection #${id} deleted.`);
      } else {
        console.error(`Connection #${id} not found.`);
        process.exit(1);
      }
    } else {
      console.error("Specify an ID, --analysis <id>, --prune, or --all.");
      process.exit(1);
    }
    closeDb();
  });

// -- db --

const dbCmd = program.command("db").description("Database operations");

dbCmd
  .command("stats")
  .description("Show database statistics")
  .option("--json", "Output as JSON")
  .action((opts) => {
    getDb();
    const stats = getDbStats();
    if (opts.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(formatDbStats(stats));
    }
    closeDb();
  });

// -- config --

const configCmd = program.command("config").description("Manage configuration");

configCmd
  .command("show")
  .description("Show current configuration")
  .action(() => {
    const config = loadConfig();
    console.log(formatConfig(config));
  });

configCmd
  .command("set <key> <value>")
  .description("Set a configuration value")
  .action((key: string, value: string) => {
    try {
      const config = loadConfig();
      const updated = setConfigValue(config, key, value);
      saveConfig(updated);
      console.log(`Set ${key} = ${value}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
