import { getDb, queryConnections } from "../db.js";
import { formatConnectionHeader, formatConnectionRow } from "../format.js";
import chalk from "chalk";

export function renderDashboard(): void {
  const REFRESH_MS = 2000;
  let offset = 0;

  getDb();

  process.stdout.write("\x1B[?1049h\x1B[H");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const getVisibleRows = () => Math.max(1, (process.stdout.rows ?? 24) - 4);

  const render = () => {
    const connections = queryConnections({ limit: 1000 });
    const total = connections.length;
    const rows = getVisibleRows();

    offset = Math.max(0, Math.min(offset, Math.max(0, total - rows)));

    const visible = connections.slice(offset, offset + rows);

    process.stdout.write("\x1B[H\x1B[2J");
    process.stdout.write(formatConnectionHeader() + "\n");

    for (const conn of visible) {
      process.stdout.write(formatConnectionRow(conn) + "\n");
    }

    const statusLine = chalk.dim(
      `  ${offset + 1}-${Math.min(offset + rows, total)} of ${total} connections  |  ` +
      `↑↓ scroll  |  q to quit  |  refreshes every 2s`
    );
    process.stdout.write(`\n${statusLine}\n`);
  };

  render();
  const interval = setInterval(render, REFRESH_MS);

  process.stdin.on("data", (key: string) => {
    const rows = getVisibleRows();
    if (key === "\u001B[A") { offset = Math.max(0, offset - 1); render(); }
    else if (key === "\u001B[B") { offset++; render(); }
    else if (key === "\u001B[5~") { offset = Math.max(0, offset - rows); render(); }
    else if (key === "\u001B[6~") { offset += rows; render(); }
    else if (key === "q" || key === "\u0003") {
      clearInterval(interval);
      process.stdout.write("\x1B[?1049l");
      process.stdin.setRawMode(false);
      process.exit(0);
    }
  });
}
