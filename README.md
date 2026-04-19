# wirewatch

[![npm](https://img.shields.io/npm/v/wirewatch?style=flat-square)](https://www.npmjs.com/package/wirewatch)

Network traffic monitoring CLI with AI-assisted anomaly detection. All data stays local in SQLite. No cloud, no telemetry.

wirewatch runs a lightweight background daemon that watches every network connection on your machine. It records what is connecting, where it is going, which process opened it, and how long it stays open. When you want answers, you run `ww analyze` and an AI model reviews the traffic and flags anything suspicious like unusual ports, unexpected destinations, unknown processes making outbound calls.

## What It Does

- captures live network connections in the background as a daemon
- stores connection metadata locally in SQLite
- resolves destination country codes via ip-api.com (free, no key required)
- runs AI analysis on recent traffic via Anthropic or OpenAI
- flags suspicious connections with risk level and plain-language summary
- supports `--json` on most commands for scripting and automation

## Tech Stack

- [TypeScript](https://www.typescriptlang.org/) on Node.js 22+
- [SQLite](https://www.sqlite.org/) via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for local storage
- [Commander](https://github.com/tj/commander.js) for CLI parsing
- [chalk](https://github.com/chalk/chalk) for terminal colors
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-node) and [OpenAI SDK](https://github.com/openai/openai-node) for AI analysis
- [ip-api.com](http://ip-api.com) for GeoIP country code resolution (free, no key required)
- `lsof` (macOS) and `/proc/net` (Linux) for passive connection capture
- `tcpdump` for deep packet capture mode
- [Vitest](https://vitest.dev/) for testing
- [Biome](https://biomejs.dev/) for linting and formatting
- [tsup](https://tsup.egoist.dev/) for building

## Requirements

- Node.js 22+
- pnpm
- macOS or Linux
- `tcpdump` for deep capture mode (requires sudo)

## Install

```bash
npm install -g wirewatch
```

Or with pnpm:

```bash
pnpm add -g wirewatch
```

After installation, the `ww` command is available globally.

### From source

```bash
git clone https://github.com/psandis/wirewatch.git
cd wirewatch
pnpm install
pnpm build
npm link
```

## Quick Start

Before starting, set your Anthropic or OpenAI API key so `ww analyze` can run:

```bash
ww config set ai.anthropic.apiKey sk-ant-...
```

Start the background daemon. It begins capturing connections immediately:

```bash
ww start
```

Watch what is connecting in real time:

```bash
ww monitor
```

Ask AI to review recent traffic and flag anything suspicious:

```bash
ww analyze
```

Stop the daemon when you are done:

```bash
ww stop
```

## Storage

Default root:

```
~/.wirewatch/
```

| Path | Description |
|------|-------------|
| `~/.wirewatch/wirewatch.db` | SQLite database |
| `~/.wirewatch/config.json` | Configuration file |
| `~/.wirewatch/daemon.log` | Daemon log |

Override the root:

```bash
export WIREWATCH_HOME=/path/to/custom/root
```

## CLI

### Start and stop the daemon

```bash
ww start
```

```
Daemon started (PID 89064). Run "ww status" to confirm.
```

```bash
ww stop
```

```
Daemon stopped (PID 89064).
```

### Check daemon status

```
ww status

● wirewatch daemon is running
  Mode         passive
  Started      2026-04-19 19:56:32
  Uptime       6s
  Connections  138
```

### View live connections

```bash
ww monitor
```

Opens an interactive live view. Refreshes from SQLite as the daemon captures. Use `↑` `↓` to scroll, `PgUp` `PgDn` to page, `q` to quit.

### List captured connections

```
ww list

ID    PROTO  SOURCE                   DESTINATION                 DIR   STATE        PROCESS     CC  LAST SEEN
257   TCP    192.168.1.5:52758        8.8.8.8:443                 out   ESTABLISHED  node        US  2026-04-19 19:56:38
256   TCP    192.168.1.5:52740        1.1.1.1:443                 out   ESTABLISHED  Chrome      US  2026-04-19 19:56:34
255   TCP    192.168.1.5:52741        140.82.114.4:443            out   ESTABLISHED  node        US  2026-04-19 19:56:34
158   TCP    192.168.1.5:52189        93.184.216.34:443           out   ESTABLISHED  curl        US  2026-04-19 19:56:32
124   TCP    192.168.1.5:50756        142.250.185.46:993          out   ESTABLISHED  Mail        US  2026-04-19 19:56:32
```

| Flag | Description |
|------|-------------|
| `--protocol tcp\|udp` | Filter by protocol |
| `--dst <ip>` | Filter by destination IP |
| `--direction inbound\|outbound\|local` | Filter by direction |
| `--process <name>` | Filter by process name |
| `--limit <n>` | Limit results (default: 100) |
| `--since <unix-ms>` | Show connections since timestamp |

### Show connection detail

```
ww show 257

Connection #257

  Protocol     TCP
  Direction    out
  Source       192.168.1.5:52758
  Destination  8.8.8.8:443
  Hostname     dns.google
  Country      US
  State        ESTABLISHED
  Process      node (PID 8821)
  Capture      passive
  Bytes sent   -
  Bytes recv   -
  Interface    en0
  First seen   2026-04-19 19:56:38
  Last seen    2026-04-19 19:56:58
  Duration     20s
```

### Run AI analysis

```
ww analyze

Analysis #1  ● low
2026-04-19 19:57:10  anthropic/claude-haiku-4-5-20251001  162 connections

Traffic appears normal. Outbound connections are predominantly HTTPS to known services
including Google, GitHub, and Cloudflare. DNS queries are directed to 1.1.1.1 and 8.8.8.8.
No unusual ports or unexpected destinations detected.
```

Notes:

- Analyzes only connections since the last run
- `--json` outputs the full structured result

### List past analyses

```
ww analyses

Analysis #1  ● low
2026-04-19 19:57:10  anthropic/claude-haiku-4-5-20251001  162 connections

Traffic appears normal. Outbound connections are predominantly HTTPS to known services
including Google, GitHub, and Cloudflare. No unusual ports or unexpected destinations detected.
```

Use `--limit <n>` to control how many results are shown (default: 20).

### Database statistics

```
ww db stats

Database Statistics

  Connections   162
  Analyses      1
  Sessions      2
  Oldest record 2026-04-19 19:48:24
  DB size       76.0KB

By protocol:
  TCP      160
  UDP      2

By direction:
  outbound   155
  inbound    6
  local      1

Top destinations:
  8.8.8.8                                  18
  1.1.1.1                                  14
  140.82.114.4                             6
  93.184.216.34                            5
  142.250.185.46                           4
```

### Delete data

| Command | Description |
|---------|-------------|
| `ww delete <id>` | Delete a single connection by ID |
| `ww delete --analysis <id>` | Delete a single analysis by ID |
| `ww delete --prune` | Prune connections older than `retentionDays` |
| `ww delete --all` | Delete all data and remove `~/.wirewatch/` directory |

The daemon must be stopped before running `ww delete --all`.

### Configuration

```
ww config show

Configuration

AI
  provider        anthropic
  anthropic.key   set
  anthropic.model claude-haiku-4-5-20251001
  openai.key      not set
  openai.model    gpt-4o-mini

Capture
  mode            passive
  interval        2s
  interfaces      all

Storage
  retentionDays   30
  dbCacheSize     -8000

GeoIP
  enabled         true
  url             http://ip-api.com/batch
  batchSize       100
  timeout         3000ms
  flushInterval   10000ms
```

```bash
ww config set <key> <value>
```

## Capture Modes

| Mode | Root required | Description |
|------|--------------|-------------|
| `passive` | No | Asks the OS what connections are open. Uses `lsof` on macOS and `/proc/net` on Linux. Polls every N seconds. |
| `deep` | Yes (sudo) | Runs `tcpdump` and intercepts every packet in real time. Catches short-lived connections and byte counts. |

```bash
ww config set capture.mode deep
sudo ww start
```

## Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `ai.provider` | `anthropic` | AI provider (`anthropic` or `openai`) |
| `ai.anthropic.apiKey` | | Anthropic API key |
| `ai.anthropic.model` | `claude-haiku-4-5-20251001` | Anthropic model |
| `ai.openai.apiKey` | | OpenAI API key |
| `ai.openai.model` | `gpt-4o-mini` | OpenAI model |
| `capture.mode` | `passive` | Capture mode (`passive` or `deep`) |
| `capture.interval` | `2` | Poll interval in seconds |
| `capture.lsofTimeout` | `5000` | lsof timeout in milliseconds |
| `storage.retentionDays` | `30` | Days to keep connection records |
| `storage.dbCacheSize` | `-8000` | SQLite cache size in kilobytes |
| `geo.enabled` | `true` | Enable GeoIP resolution |
| `geo.url` | `http://ip-api.com/batch` | GeoIP API endpoint |
| `geo.batchSize` | `100` | GeoIP batch size (max 100) |
| `geo.timeout` | `3000` | GeoIP request timeout in milliseconds |
| `geo.flushInterval` | `10000` | GeoIP flush interval in milliseconds |

## Project Structure

```
src/
  cli.ts                   entry point for the ww command
  daemon.ts                background capture process
  types.ts                 shared TypeScript types
  lib/
    ai.ts                  AI analysis via Anthropic or OpenAI
    config.ts              configuration load, save, and validation
    db.ts                  SQLite database layer
    format.ts              terminal output formatting
    geo.ts                 GeoIP enrichment queue
    capture/
      index.ts             capture orchestration and diff logic
      passive.ts           passive capture via lsof and /proc
      deep.ts              deep capture via tcpdump
    tui/
      index.tsx            live connection monitor view
tests/
  ai.test.ts
  capture.test.ts
  config.test.ts
  db.test.ts
```

## Development

Clone, install, and build:

```bash
git clone https://github.com/psandis/wirewatch.git
cd wirewatch
pnpm install
pnpm build
npm link
```

After `npm link`, the `ww` command is available globally. Run `ww --help` to verify.

```bash
pnpm test        # 64 tests across config, db, capture, and ai modules
pnpm typecheck
pnpm lint
```

## License

See [MIT](LICENSE)
