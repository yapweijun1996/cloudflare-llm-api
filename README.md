# Local OpenAI-Style Stack  
(llama.cpp + Node Gateway + Cloudflare Tunnel)

This setup lets you:

- Run a local OpenAI-compatible API using `llama-server` (from `llama.cpp`)
- Protect it with a Node.js gateway that checks `Authorization: Bearer <API_KEY>`
- Safely expose it to the internet via Cloudflare Tunnel
- Control all processes with a simple PM2 menu (`pm2-simple.js`)

Goal: a junior engineer can follow this step by step.

---

## 0. Architecture Overview

Turn your machine into your own OpenAI-style stack:

```text
[Browser / Frontend]
      |
      |  HTTPS + Authorization: Bearer sk-xxx
      v
[Cloudflare Tunnel]  -->  api.your-domain.com
      |
      v
[Node.js Gateway]  -->  http://localhost:8787
      |
      v
[llama-server (llama.cpp)]  -->  http://localhost:5857
````

- `llama-server`: runs the local LLM process (GGUF model)
- `gateway`: checks API key, handles CORS, forwards to llama
- `cloudflared`: safely exposes `https://api.your-domain.com`
- `pm2-simple.js`: number-based menu for start/stop/status

---

## 1. What’s in this repo

- **`llama-server`** (from `llama.cpp`)  
  Serves OpenAI-style endpoint: `POST /v1/chat/completions`

- **`gateway/`** (Node.js)  
  - Enforces `Authorization: Bearer <key>`  
  - Proxies requests to `llama-server`  
  - Handles CORS for browser apps

- **`pm2-simple.js`**  
  Keyboard menu to start/stop everything (llama / gateway / tunnel)

- **`pm2-config.json`**  
  Configure:
  - llama command + model path
  - gateway command
  - cloudflared tunnel command

---

## 2. Prerequisites

Make sure you have:

- Node.js 18+
- PM2 installed globally  
  ```bash
  npm i -g pm2
  ```
- `llama.cpp` installed and `llama-server` in PATH (run `llama-server -h`)
- `cloudflared` installed and logged in to Cloudflare  
  ```bash
  cloudflared tunnel login
  ```
- A domain managed in Cloudflare (example: `api.b1122333.com`)

---

## 3. Step 1 – Start llama.cpp locally

### 3.1 Configure llama in `pm2-config.json`

Edit the `"llama"` section with your model path and port, for example:

```json
"llama": {
  "command": "llama-server",
  "args": [
    "--model", "/absolute/path/to/your-model.gguf",
    "--port", "5857",
    "--ctx-size", "16384",
    "--threads", "-1",
    "--jinja"
  ]
}
```

Tips:
- `--model` must be an absolute path, or PM2 will not find it when directories change.
- `--port` is the local llama port; the gateway must use the same.

### 3.2 Start llama with the PM2 menu

```bash
node pm2-simple.js
```

In the menu:
- `a` → start all (llama + gateway + tunnel)
- `5` → start llama only
- `0` → refresh status

`llama` showing `online` means the model is running.

---

### 3.3 How `--jinja` builds the prompt (chat template)

`llama-server --jinja` turns OpenAI-style messages into the real prompt via a Jinja chat template:

1. Receives JSON like `{"messages":[{"role":"system","content":"You are..."},{"role":"user","content":"Hello"}]}`
2. Pipes those messages into a Jinja template that formats the conversation
3. The rendered text is what the model actually sees

Template sources:
- Most instruct GGUFs already ship a `tokenizer.chat_template`; if so, `--jinja` will auto-use it.
- To override or supply your own, set `LLAMA_CHAT_TEMPLATE` (works well with PM2 env). Some builds have `--chat-template` CLI, but the env var is easier when multiline.

Example template (instruction-style tags):

```jinja
{% set system_message = "" %}
{% for m in messages %}
  {% if m.role == "system" %}
    {% set system_message = m.content %}
  {% endif %}
{% endfor %}

<System>
{{ system_message }}
</System>

{% for m in messages %}
  {% if m.role == "user" %}
<User>
{{ m.content }}
</User>
  {% elif m.role == "assistant" %}
<Assistant>
{{ m.content }}
</Assistant>
  {% endif %}
{% endfor %}

<Assistant>
```

Add it to PM2 via `pm2-config.json`:

```json
"llama": {
  "command": "llama-server",
  "args": ["--model", "/abs/path/model.gguf", "--port", "5857", "--ctx-size", "16000", "--threads", "-1", "--jinja"],
  "env": {
    "LLAMA_CHAT_TEMPLATE": "{% set system_message = \"\" %}\\n{% for m in messages %}\\n  {% if m.role == \"system\" %}\\n    {% set system_message = m.content %}\\n  {% endif %}\\n{% endfor %}\\n\\n<System>\\n{{ system_message }}\\n</System>\\n\\n{% for m in messages %}\\n  {% if m.role == \"user\" %}\\n<User>\\n{{ m.content }}\\n</User>\\n  {% elif m.role == \"assistant\" %}\\n<Assistant>\\n{{ m.content }}\\n</Assistant>\\n  {% endif %}\\n{% endfor %}\\n\\n<Assistant>\\n"
  }
}
```

Tip: if the model already replies in a normal chat style with only `--jinja`, you likely don’t need a custom template.

---

## 4. Step 2 – Configure and start the Gateway

The gateway:
- Checks `Authorization: Bearer xxx`
- Proxies to `http://127.0.0.1:5857`
- Handles CORS for browsers

### 4.1 Set `.env`

```bash
cp gateway/.env.example gateway/.env
```

Edit `gateway/.env`, for example:

```env
LLM_API_KEYS=sk-your-demo-key
LLM_UPSTREAM=http://127.0.0.1:5857
GATEWAY_PORT=8787

# For development you can temporarily use *
CORS_ALLOW_ORIGIN=*
```

Notes:
- `LLM_API_KEYS` supports multiple keys, comma-separated (e.g., `sk-key-1,sk-key-2`)
- `LLM_UPSTREAM` port must match the `llama-server --port`
- `GATEWAY_PORT` is the local port exposed by the gateway

### 4.2 Start the gateway via PM2

In `node pm2-simple.js`:
- `1` → start gateway
- `2` → stop gateway
- `0` → refresh status
- `9` → view gateway logs

Quick local test (requires llama + gateway online):

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-demo-key" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [{ "role": "user", "content": "hello from gateway" }]
  }'
```

If you get an assistant reply, llama + gateway are working.

---

## 5. Step 3 – Create and run a Cloudflare Tunnel

Expose `http://localhost:8787` as `https://api.b1122333.com`.

### 5.1 Create Tunnel and DNS (once)

```bash
cloudflared tunnel create my-tunnel
cloudflared tunnel route dns my-tunnel api.b1122333.com
```

Note the returned tunnel id, for example:

```
6da0b7da-ec47-41f5-904c-601a8d68748c
```

### 5.2 Write Cloudflare Tunnel config

Put this in `~/.cloudflared/config.yml`:

```yaml
tunnel: 6da0b7da-ec47-41f5-904c-601a8d68748c
credentials-file: /Users/yapweijun/.cloudflared/6da0b7da-ec47-41f5-904c-601a8d68748c.json

ingress:
  - hostname: api.b1122333.com
    service: http://localhost:8787   # gateway port
  - service: http_status:404
```

### 5.3 Configure the tunnel process in `pm2-config.json`

```json
"tunnel": {
  "command": "cloudflared",
  "args": [
    "tunnel",
    "--config", "/Users/yapweijun/.cloudflared/config.yml",
    "run", "6da0b7da-ec47-41f5-904c-601a8d68748c"
  ]
}
```

Ensure `--config` matches the config path and the final ID matches the tunnel id.

### 5.4 Start the tunnel via PM2

In `node pm2-simple.js`:
- `3` → start tunnel
- `4` → stop tunnel
- Or `a` to start everything

Confirm `tunnel` shows `online`.

---

## 6. Step 4 – End-to-End API Test

### 6.1 Local via gateway

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-demo-key" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "user", "content": "hello (local gateway)" }
    ]
  }'
```

### 6.2 Remote via Cloudflare

```bash
curl https://api.b1122333.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-demo-key" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "user", "content": "hello from the internet" }
    ]
  }'
```

If both return answers, everything is working (llama.cpp, gateway, Cloudflare tunnel + DNS, API key check).

---

## 7. PM2 Menu Cheat Sheet (`pm2-simple.js`)

Run:

```bash
node pm2-simple.js
```

Keys:
- `a` / `7` → start all (llama + gateway + tunnel)
- `k` / `8` → stop all
- `1` / `2` → start / stop gateway
- `3` / `4` → start / stop tunnel
- `5` / `6` → start / stop llama
- `0` → refresh status
- `9` → view gateway logs

Recommended for juniors:
- First run: `a` to start everything
- Debugging: use `9` for logs, plus `pm2 logs` / `pm2 status`

---

## 8. Security Notes

1) Do not hardcode real API keys in frontend code  
   - No `sk-xxx` in `index.html` / React / Vue  
   - Either let users enter their own key (BYOK) or route through your gateway/backend

2) Tighten CORS before production  
   - Dev can temporarily set `CORS_ALLOW_ORIGIN=*`  
   - Prod should use a specific domain, e.g., `https://your-frontend-domain.com`

3) Add basic safeguards  
   - In `gateway/gateway.js`: add rate limiting and write request/error logs to files  
   - Add Cloudflare WAF or IP restrictions for extra protection

---

## 9. Next Steps (optional ideas)

- Add multiple model presets (different GGUF models on different ports)
- Add `/v1/embeddings` and pair with a local vector DB for RAG
- Use Cloudflare WAF + API Shield for stronger protection
- Build a simple chat UI that calls `https://api.your-domain.com/v1/chat/completions`

---
