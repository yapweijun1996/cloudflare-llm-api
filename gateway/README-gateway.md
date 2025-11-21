# LLM Gateway (OpenAI-style API key front door)

一个轻量 Node.js 网关，用 `Authorization: Bearer sk-xxx` 验证 API Key，再把请求转发到你本机的 `llama-server` (`localhost:5857`)。可用于 Cloudflare Tunnel 公开访问。

## 初始化

```bash
cd gateway
npm install
cp .env.example .env
# 按需编辑 .env 中的 LLM_API_KEYS、LLM_UPSTREAM、GATEWAY_PORT
```

`.env` 示例：
```
LLM_API_KEYS=sk-tno-llm-2025-1,sk-tno-llm-2025-2
LLM_UPSTREAM=http://127.0.0.1:5857
GATEWAY_PORT=8787
```

## 启动顺序
1) 先启动 `llama-server`（例如端口 5857）。  
2) 再启动网关：
```bash
npm start
# 或 node gateway.js
```
看到日志：
```
✅ LLM Gateway starting with config:
  - Port: 8787
  - Upstream: http://127.0.0.1:5857
  - Valid API keys: 2
🚀 LLM API Gateway listening on http://localhost:8787
```

## 本地测试
正确的 Key：
```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-tno-llm-2025-1" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [{ "role": "user", "content": "Hello via gateway" }]
  }'
```
错误或缺失的 Key 会返回：
```json
{
  "error": {
    "message": "Incorrect API key provided.",
    "type": "invalid_api_key"
  }
}
```

## Cloudflare Tunnel 配置示例
把 Tunnel 的 `service` 指向网关端口（8787），而不是直接指向 llama-server：
```yaml
ingress:
  - hostname: api.b1122333.com
    service: http://localhost:8787
  - service: http_status:404
```
重启 Tunnel 后，公网调用：
```bash
curl https://api.b1122333.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-tno-llm-2025-1" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [{ "role": "user", "content": "Hello from Internet via Gateway" }]
  }'
```

## 前端如何调用
- `Base URL` 设置为指向网关（例如 `https://api.b1122333.com/v1`）。
- `Authorization` 头用 `Bearer sk-...`。
- 如果你继续保留 Cloudflare 的 `X-My-LLM-Key` WAF 规则，可以在前端额外添加该 Header；否则只用 Bearer 即可。

## 后续扩展思路
- 把 API Keys 放数据库，做开关、备注、速率限制。
- 增加 `/v1/embeddings` 等转发路由。
- 请求日志写入文件或对象存储，方便审计/计费。
