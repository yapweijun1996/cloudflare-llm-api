#!/usr/bin/env node
/**
 * Lightweight PM2 terminal control center for this project.
 * No dependencies beyond a working `pm2` binary.
 *
 * Features:
 *  - Show process status (CPU, memory, uptime).
 *  - Start/restart/stop/delete presets with short commands.
 *  - Quick log viewer (last 80 lines, no streaming).
 *
 * Presets can be edited below to fit your local commands.
 */
const { execFile } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");

const presets = [
  {
    key: "gateway",
    label: "Gateway API (node)",
    command: "npm",
    args: ["start"],
    cwd: path.join(__dirname, "gateway"),
    note: "Uses gateway/.env for keys and upstream config.",
  },
  {
    key: "tunnel",
    label: "Cloudflare Tunnel",
    command: "cloudflared",
    args: ["tunnel", "run"],
    cwd: process.cwd(),
    note: "Requires an existing cloudflared tunnel config.",
  },
  {
    key: "llama",
    label: "llama-server (edit command for your model)",
    command: "llama-server",
    args: [
      "-hf",
      "unsloth/gpt-oss-20b-GGUF:gpt-oss-20b-Q4_K_M.gguf",
      "--port",
      "5857",
      "--ctx-size",
      "16384",
      "--threads",
      "-1",
      "--jinja",
      "--reasoning-format",
      "none",
    ],
    cwd: process.cwd(),
    note: "Update model/flags to match your hardware.",
  },
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});

async function main() {
  await ensurePm2();
  await renderStatus();
  printPresets();
  printHelp();
  prompt();
}

async function renderStatus() {
  const list = await getPm2List();
  console.log("\nPM2 status");
  if (!list.length) {
    console.log("  (no processes found)");
    return;
  }

  const header =
    pad("name", 15) +
    pad("status", 12) +
    pad("cpu%", 8) +
    pad("mem", 10) +
    pad("uptime", 12) +
    "cmd";
  console.log(header);
  console.log("-".repeat(header.length));

  list.forEach((p) => {
    const status = p.pm2_env?.status || "unknown";
    const cpu = p.monit?.cpu ?? 0;
    const mem = p.monit?.memory ?? 0;
    const uptimeMs = Date.now() - (p.pm2_env?.pm_uptime || 0);
    const cmd = p.pm2_env?.pm_exec_path || "";
    const args = p.pm2_env?.args ? " " + p.pm2_env.args.join(" ") : "";

    console.log(
      pad(p.name || p.pm_id, 15) +
        pad(status, 12) +
        pad(cpu.toFixed(0), 8) +
        pad(formatBytes(mem), 10) +
        pad(formatDuration(uptimeMs), 12) +
        `${cmd}${args}`
    );
  });
}

function printPresets() {
  console.log("\nPresets (editable in pm2-control.js):");
  presets.forEach((p) => {
    console.log(`  - ${p.key}: ${p.label}`);
    console.log(`      cmd: ${p.command} ${p.args.join(" ")} (cwd: ${p.cwd})`);
    if (p.note) console.log(`      note: ${p.note}`);
  });
}

function printHelp() {
  console.log("\nCommands:");
  console.log("  s <key>   start preset (pm2 start)");
  console.log("  r <key>   restart process");
  console.log("  x <key>   stop process");
  console.log("  d <key>   delete from pm2");
  console.log("  l <key>   show last 80 log lines");
  console.log("  u         refresh status");
  console.log("  p         show presets again");
  console.log("  h         show this help");
  console.log("  q         quit");
}

function prompt() {
  rl.question("\npm2> ", async (answer) => {
    const [cmd, arg] = answer.trim().split(/\s+/, 2);
    try {
      if (!cmd) {
        // no-op
      } else if (cmd === "q") {
        rl.close();
        process.exit(0);
      } else if (cmd === "u") {
        await renderStatus();
      } else if (cmd === "p") {
        printPresets();
      } else if (cmd === "h") {
        printHelp();
      } else if (["s", "start"].includes(cmd)) {
        await startPreset(arg);
        await renderStatus();
      } else if (["r", "restart"].includes(cmd)) {
        await runPm2(["restart", arg]);
        await renderStatus();
      } else if (["x", "stop"].includes(cmd)) {
        await runPm2(["stop", arg]);
        await renderStatus();
      } else if (["d", "delete"].includes(cmd)) {
        await runPm2(["delete", arg]);
        await renderStatus();
      } else if (["l", "logs"].includes(cmd)) {
        await showLogs(arg);
      } else {
        console.log("Unknown command. Type h for help.");
      }
    } catch (err) {
      console.error(err.message || err);
    }
    prompt();
  });
}

async function startPreset(key) {
  const preset = presets.find((p) => p.key === key);
  if (!preset) {
    throw new Error(`Preset not found: ${key}`);
  }

  const args = [
    "start",
    preset.command,
    "--name",
    preset.key,
    "--cwd",
    preset.cwd,
    "--time",
    "--",
    ...preset.args,
  ];

  await runPm2(args, {
    env: {
      ...process.env,
    },
  });
}

async function showLogs(key) {
  if (!key) throw new Error("Provide a process name for logs, e.g. l gateway");
  await runPm2(["logs", key, "--lines", "80", "--nostream"]);
}

async function ensurePm2() {
  try {
    await runPm2(["-v"]);
  } catch (err) {
    throw new Error(
      "pm2 is not available. Install it globally (npm i -g pm2) before using this tool."
    );
  }
}

async function getPm2List() {
  try {
    const stdout = await runPm2(["jlist"]);
    return JSON.parse(stdout || "[]");
  } catch (err) {
    console.error("Failed to read pm2 list:", err.message || err);
    return [];
  }
}

function runPm2(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile("pm2", args, options, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            stderr?.trim() ||
              stdout?.trim() ||
              error.message ||
              "Unknown pm2 error"
          )
        );
        return;
      }
      if (stdout?.trim()) console.log(stdout.trim());
      if (stderr?.trim()) console.error(stderr.trim());
      resolve(stdout);
    });
  });
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
