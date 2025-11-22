#!/usr/bin/env node
/**
 * Ultra-simple PM2 menu (numbers only).
 * Requires: pm2 installed globally. No other deps.
 */
const { execFile } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");

const CONFIG_PATH = path.join(__dirname, "pm2-config.json");
const config = loadConfig();

const presets = {
  gateway: {
    name: config.gateway?.name || "gateway",
    command: config.gateway?.command || "npm",
    args: config.gateway?.args || ["start"],
    cwd: path.resolve(__dirname, config.gateway?.cwd || "gateway"),
  },
  tunnel: {
    name: config.tunnel?.name || "tunnel",
    command: config.tunnel?.command || "cloudflared",
    args: config.tunnel?.args || ["tunnel", "run"],
    cwd: path.resolve(__dirname, config.tunnel?.cwd || "."),
  },
  llama: {
    name: config.llama?.name || "llama",
    command: config.llama?.command || "llama-server",
    args:
      config.llama?.args || [
        "--model",
        "/path/to/your-model.gguf",
        "--port",
        "5857",
      ],
    cwd: path.resolve(__dirname, config.llama?.cwd || "."),
  },
};

const menu = [
  ["1", "Start gateway", () => start("gateway")],
  ["2", "Stop gateway", () => stop("gateway")],
  ["3", "Start tunnel", () => start("tunnel")],
  ["4", "Stop tunnel", () => stop("tunnel")],
  ["5", "Start llama", () => start("llama")],
  ["6", "Stop llama", () => stop("llama")],
  ["7", "Start ALL", () => startAll()],
  ["8", "Stop ALL", () => stopAll()],
  ["a", "Start ALL (quick key)", () => startAll()],
  ["k", "Stop ALL (quick key)", () => stopAll()],
  ["9", "Logs gateway (80 lines)", () => logs("gateway")],
  ["0", "Refresh status", () => renderStatus()],
  ["q", "Quit", () => quit()],
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

async function main() {
  await ensurePm2();
  ensureTunnelConfig(presets.tunnel);
  await renderStatus();
  printMenu();
  prompt();
}

function prompt() {
  rl.question("\nChoose option: ", async (ans) => {
    const choice = ans.trim();
    const item = menu.find(([key]) => key === choice);
    if (!item) {
      console.log("Unknown option.");
      return prompt();
    }
    try {
      await item[2]();
    } catch (err) {
      console.error(err.message || err);
    }
    prompt();
  });
}

function printMenu() {
  console.log("\n=== PM2 Simple Menu ===");
  menu.forEach(([key, label]) => console.log(` ${key}) ${label}`));
}

async function start(key) {
  const p = presets[key];
  if (!p) throw new Error(`Preset not found: ${key}`);
  // Drop any prior instance so we don't accumulate errored duplicates.
  await runPm2(["delete", p.name]).catch(() => {});
  await runPm2([
    "start",
    p.command,
    "--name",
    p.name,
    "--cwd",
    p.cwd,
    "--time",
    "--",
    ...p.args,
  ]);
  await renderStatus();
}

async function stop(key) {
  await runPm2(["stop", key]).catch(() => {});
  await runPm2(["delete", key]).catch(() => {});
  await renderStatus();
}

async function startAll() {
  for (const key of Object.keys(presets)) {
    await start(key);
  }
}

async function stopAll() {
  for (const key of Object.keys(presets)) {
    await stop(key);
  }
}

async function logs(key) {
  await runPm2(["logs", key, "--lines", "80", "--nostream"]);
}

async function renderStatus() {
  const list = await getPm2List();
  console.log("\nPM2 status:");
  if (!list.length) {
    console.log(" (no processes)");
    return;
  }
  const header =
    pad("name", 18) +
    pad("status", 10) +
    pad("pid", 8) +
    pad("cpu%", 8) +
    pad("mem", 10) +
    pad("restarts", 10) +
    pad("uptime", 12);
  console.log(header);
  console.log("-".repeat(header.length));

  list.forEach((p) => {
    const status = p.pm2_env?.status || "unknown";
    const pid = p.pid ?? "?";
    const cpu = p.monit?.cpu ?? 0;
    const mem = p.monit?.memory ?? 0;
    const restarts = p.pm2_env?.restart_time ?? 0;
    const uptimeMs = Date.now() - (p.pm2_env?.pm_uptime || 0);

    console.log(
      pad(p.name || p.pm_id, 18) +
        pad(status, 10) +
        pad(pid, 8) +
        pad(cpu.toFixed(1), 8) +
        pad(formatBytes(mem), 10) +
        pad(restarts, 10) +
        pad(formatDuration(uptimeMs), 12)
    );
  });
}

async function ensurePm2() {
  await runPm2(["-v"], { quiet: true }).catch(() => {
    throw new Error("pm2 not found. Install with: npm i -g pm2");
  });
}

function getPm2List() {
  return runPm2(["jlist"], { quiet: true })
    .then((stdout) => JSON.parse(stdout || "[]"))
    .catch(() => []);
}

function runPm2(args, options = {}) {
  return new Promise((resolve, reject) => {
    const { quiet, ...rest } = options;
    execFile("pm2", args, rest, (error, stdout, stderr) => {
      if (error) {
        return reject(
          new Error(
            stderr?.trim() ||
              stdout?.trim() ||
              error.message ||
              "pm2 command failed"
          )
        );
      }
      if (!quiet) {
        if (stdout?.trim()) console.log(stdout.trim());
        if (stderr?.trim()) console.error(stderr.trim());
      }
      resolve(stdout);
    });
  });
}

function quit() {
  rl.close();
  process.exit(0);
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Config not found or invalid at ${CONFIG_PATH}, using defaults.`);
    return {};
  }
}

function ensureTunnelConfig(tunnelPreset) {
  const configPath = findCloudflaredConfigPath(tunnelPreset?.args);
  if (!configPath) return;

  const absPath = path.resolve(tunnelPreset.cwd || __dirname, configPath);
  const inRepo = absPath.startsWith(path.resolve(__dirname));

  if (!fs.existsSync(absPath) && inRepo) {
    const template = `# cloudflared tunnel config (generated if missing)
# Update these fields before running:
tunnel: my-b1122333
credentials-file: /path/to/my-b1122333.json
ingress:
  - hostname: api.b1122333.com
    service: http://localhost:8787
  - service: http_status:404
`;
    fs.writeFileSync(absPath, template, "utf8");
    console.warn(`Created missing cloudflared config template at ${absPath}. Edit it to match your tunnel before starting.`);
  }
}

function findCloudflaredConfigPath(args = []) {
  const idx = args.findIndex((a) => a === "--config");
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function pad(str, width) {
  str = String(str ?? "");
  if (str.length >= width) return str + " ";
  return str.padEnd(width, " ");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(1)} ${units[idx]}`;
}

function formatDuration(ms) {
  if (ms <= 0 || Number.isNaN(ms)) return "0s";
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  if (hr > 0) return `${hr}h${String(min % 60).padStart(2, "0")}m`;
  if (min > 0) return `${min}m${String(sec % 60).padStart(2, "0")}s`;
  return `${sec}s`;
}
