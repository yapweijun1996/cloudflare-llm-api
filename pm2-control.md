# PM2 Terminal Control Center

Small, dependency-free TUIs to manage the processes in this repo via PM2. The quickest option is the number-only menu (`pm2-simple.js`); the fuller command-style UI (`pm2-control.js`) is also available if you prefer typed commands.

All presets now read from `pm2-config.json`, so you can edit tunnel/gateway/llama commands and working directories in one place.

## Prerequisites
- PM2 installed globally: `npm i -g pm2`
- Your usual runtime tools installed (`cloudflared`, `llama-server`, Node)

## Usage
```bash
node pm2-control.js
```

You’ll see the current PM2 table plus the presets defined at the top of `pm2-control.js`. Commands:
- `s <key>` start a preset (e.g. `s gateway`)
- `r <key>` restart, `x <key>` stop, `d <key>` delete
- `l <key>` show last 80 log lines for a process
- `u` refresh, `p` show presets, `h` help, `q` quit

## Presets included (editable)
- `gateway`: runs `npm start` in `gateway/` (uses `.env`)
- `tunnel`: runs `cloudflared tunnel run`
- `llama`: runs a sample `llama-server` command — edit flags/model for your machine

Tip: keep your real `.env` and Cloudflare tunnel config outside of version control. The tool only shells out to `pm2`; no extra packages are required.

## Want even simpler?  
Use the number-only menu:
```bash
node pm2-simple.js
```
Menu options: start/stop each preset, start/stop all (`7`/`8` or quick keys `a`/`k`), show logs, refresh status, quit. The script auto-cleans any old/errored instance before starting. Edit `pm2-config.json` (recommended) or the presets at the top of `pm2-simple.js` if you need different commands or paths.

Typical flow with the simple menu:
1) `a` (start all) to bring up llama, gateway, tunnel together.
2) `0` to refresh status and confirm all are `online`.
3) `9` to view gateway logs if something fails.

Notes on tunnel config:
- The default tunnel args in `pm2-config.json` use `./cloudflared-config.yml` so you can keep config inside this repo.
- If that file is missing and the path is inside the repo, `pm2-simple.js` will auto-generate a template. Edit the generated file with your tunnel name, credentials file, and hostname mapping before starting.***
