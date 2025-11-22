# Local OpenAI-Style Stack (llama.cpp + Gateway + Cloudflare)

This repo lets you run a local OpenAI-compatible API with API keys, expose it via Cloudflare Tunnel, and control the processes with a simple PM2 menu.

## What’s inside
- `llama-server` (from llama.cpp) — serves `/v1/chat/completions`
- `gateway/` — Node.js front door enforcing `Authorization: Bearer <key>`
- `pm2-simple.js` — number-only PM2 controller (start/stop all)
- `pm2-config.json` — one place to edit commands/paths for llama, gateway, tunnel

## Prerequisites
- Node.js 18+
- PM2 globally: `npm i -g pm2`
- llama.cpp installed (`llama-server` in PATH)
- cloudflared installed and logged in (`cloudflared tunnel login`)
- A Cloudflare-managed domain (e.g., `api.b1122333.com`)

## Step 1: Start llama.cpp locally
Edit `pm2-config.json` to point to your model and port:
```json
"llama": {
  "command": "llama-server",
  "args": [
    "--model", "/path/to/your-model.gguf",
    "--port", "5857",
    "--ctx-size", "16384",
    "--threads", "-1",
    "--jinja"
  ]
}
```
Then run the PM2 menu and start all:
```bash
node pm2-simple.js
# press a  (start all) or 5 (start llama), 0 to refresh status
```
You should see `llama` as `online`.

## Step 2: Configure the Gateway
Copy and edit environment:
```bash
cp gateway/.env.example gateway/.env
# set keys and upstream (port must match llama)
LLM_API_KEYS=sk-your-demo-key
LLM_UPSTREAM=http://127.0.0.1:5857
GATEWAY_PORT=8787
```
Start gateway via PM2 menu (included in “start all”). Check status/logs:
- Status: press `0`
- Logs: press `9` (gateway logs)

## Step 3: Create Cloudflare Tunnel
Create and configure a tunnel (one-time):
```bash
cloudflared tunnel create my-tunnel
cloudflared tunnel route dns my-tunnel api.b1122333.com
```
Write the tunnel config (example):
```
tunnel: 6da0b7da-ec47-41f5-904c-601a8d68748c
credentials-file: /Users/yapweijun/.cloudflared/6da0b7da-ec47-41f5-904c-601a8d68748c.json

ingress:
  - hostname: api.b1122333.com
    service: http://localhost:8787   # gateway port
  - service: http_status:404
```
Point the PM2 tunnel preset to that config and tunnel name in `pm2-config.json`:
```json
"tunnel": {
  "command": "cloudflared",
  "args": [
    "tunnel", "--config", "/Users/yapweijun/.cloudflared/config.yml",
    "run", "6da0b7da-ec47-41f5-904c-601a8d68748c"
  ]
}
```
In the PM2 menu, press `3` (or `a` to start all) and confirm `tunnel` is `online`.

## Step 4: Call the API
Local test (gateway):
```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-demo-key" \
  -d '{"model": "gpt-oss-20b", "messages": [{"role": "user","content": "hello"}]}'
```
Remote test (through Cloudflare):
```bash
curl https://api.b1122333.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-demo-key" \
  -d '{"model": "gpt-oss-20b", "messages": [{"role": "user","content": "hello"}]}'
```

## PM2 quick reference (pm2-simple.js)
- `a` / `7`: start all (llama + gateway + tunnel)
- `k` / `8`: stop all
- `1/2`: start/stop gateway
- `3/4`: start/stop tunnel
- `5/6`: start/stop llama
- `0`: refresh status
- `9`: gateway logs

## Security notes
- Do not ship real API keys in front-end code. `index.html` should prompt for a key or rely on the gateway.
- Tighten CORS in `gateway/.env` once you know your front-end origin (e.g., `CORS_ALLOW_ORIGIN=http://localhost:7788`).
- Rate limit and log in `gateway/gateway.js` if exposing publicly.
