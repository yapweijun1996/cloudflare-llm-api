# 在家自架「類 OpenAI API」：llama.cpp + Cloudflare Tunnel + Node.js API Key Gateway 實戰全記錄

> 本文是一份完整的技術報告 / 教學筆記，  
> 目標是：**在自己家裡的 Mac/PC 上，建立一個有 API Key 的「類 OpenAI」大語言模型服務**，  
> 並用 Cloudflare 安全地公開到互聯網。

---

## 1. 為什麼要自己架 LLM API？

一般我們用的 GPT-4 / GPT-5 這種雲端大模型，有幾個痛點：

- 成本高：大量 token 使用時費用很可觀  
- 隱私疑慮：某些公司內部資料不想離開本地  
- 不可控：依賴第三方服務，掛了就不能用

自架的想像是：

> 「我想要一個**自己的 OpenAI**：
> - 模型跑在自己機器上  
> - API 風格跟 OpenAI 一樣（`/v1/chat/completions`）  
> - 有自己的 API Key 機制  
> - 可以從任何地方透過網路調用」

這篇就一步一步把這個目標拆開來實作。

---

## 2. 整體架構概覽（High-level Architecture）

最終架構長這樣：

```text
[Client / 前端 / 你的 App]
        │  HTTPS + Authorization: Bearer sk-xxx
        ▼
[Cloudflare Edge]  ← 負責 DNS + TLS + WAF
        │  加密 Tunnel
        ▼
[cloudflared on your Mac]
        │  HTTP
        ▼
[Node.js API Gateway @ localhost:8787]
  (驗證 API Key、轉發請求)
        │  HTTP (only localhost)
        ▼
[llama-server @ localhost:5857]
  (llama.cpp OpenAI-compatible server + GGUF 模型)
````

關鍵角色：

* **llama-server（llama.cpp）**

  * 負責載入本地 GGUF 模型
  * 提供 **OpenAI 兼容的 API**：`/v1/chat/completions`、`/v1/embeddings` 等

* **Cloudflare Tunnel (`cloudflared`)**

  * 從你家電腦「主動」連到 Cloudflare
  * 幫你把 `https://api.your-domain.com` 的流量轉回本地服務

* **Node.js API Gateway**

  * 負責「OpenAI 風格的 API Key 機制」
  * 驗證 `Authorization: Bearer sk-xxx`
  * 驗證通過才把請求轉發到 `llama-server`

---

## 3. 準備工作（Prerequisites）

### 3.1 硬體建議

以 **gpt-oss-20B GGUF** 這類 20B 級別模型為例：

* 建議記憶體：**≥ 16 GB RAM**（越多越好）
* 也可以選擇較小的 7B / 8B 模型做起步測試

### 3.2 軟體需求

* macOS / Linux / Windows 皆可（例子以 macOS 為主）
* 已安裝：

  * Homebrew（macOS）
  * Node.js 18+（內建 fetch）
* 一個自己的網域（如 `b1122333.com`）
* 該網域的 DNS 已託管在 Cloudflare（nameserver 指過去）

### 3.3 快速啟動：PM2 菜單（選用）
專案根目錄附了超簡單的 PM2 控制台，可一次啟動/停止所有服務：
```bash
node pm2-simple.js
```
常用按鍵：`a`/`7` 啟動全部（llama + gateway + tunnel）、`k`/`8` 停止全部、`0` 刷新狀態、`9` 查看 gateway 日誌。若要改模型或端口，直接編輯 `pm2-simple.js` 頂部的 `llama` 預設；確保端口與 `.env` 中的 `LLM_UPSTREAM` 保持一致。

---

## 4. Step 1：在本地啟動 llama.cpp 的 HTTP Server

### 4.1 安裝 llama.cpp（macOS 示例）

```bash
brew install llama.cpp
```

安裝完成後，應該會有：

* `llama-cli`
* `llama-server`

可用：

```bash
which llama-server
```

### 4.2 選擇模型：gpt-oss-20B GGUF

這裡假設使用 Unsloth 提供的 **gpt-oss-20b-GGUF** 模型，支援在本地以 GGUF 量化格式運行：

* Hugging Face: `unsloth/gpt-oss-20b-GGUF`
* 可以選擇 4-bit quant，例如：`gpt-oss-20b-Q4_K_M.gguf`

### 4.3 啟動 `llama-server`

```bash
llama-server \
  -hf unsloth/gpt-oss-20b-GGUF:gpt-oss-20b-Q4_K_M.gguf \
  --port 5857 \
  --ctx-size 16384 \
  --threads -1 \
  --jinja \
  --reasoning-format none
```

參數說明（給初學者看得懂的版本）：

* `-hf ...`
  從 Hugging Face 下載並載入指定 GGUF 模型（首次會下載，之後用快取）。
* `--port 5857`
  在本機開一個 HTTP 服務：`http://localhost:5857`
* `--ctx-size 16384`
  最大 context 長度（token 數），越大越吃記憶體。
* `--threads -1`
  使用所有 CPU 核心。
* `--jinja`
  啟用模型內建的 chat template（對 GPT-OSS 類模型很重要）。
* `--reasoning-format none`
  關閉特別的 reasoning trace 格式，輸出比較乾淨。

### 4.4 測試本地 OpenAI 風格 API

在另一個 Terminal 測試：

```bash
curl http://localhost:5857/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "user", "content": "Hello from localhost 5857" }
    ]
  }'
```

如果一切正常，會收到類似：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      }
    }
  ],
  "model": "gpt-oss-20b",
  "object": "chat.completion"
}
```

這樣代表：

* **你的本地 LLM 已經透過 OpenAI 兼容的 REST API 在運作**

---

## 5. Step 2：用 Cloudflare Tunnel 安全公開本地服務

### 5.1 安裝 `cloudflared`

macOS 例子：

```bash
brew install cloudflared
```

### 5.2 登入 Cloudflare 帳號

```bash
cloudflared tunnel login
```

瀏覽器會打開 Cloudflare 登入頁面，登入並授權後，會在 `~/.cloudflared/` 生成 `cert.pem`。

### 5.3 建立一條 Tunnel

```bash
cloudflared tunnel create my-llm
```

結果會顯示：

* 新的 tunnel ID，例如：`6da0b7da-ec47-41f5-904c-601a8d68748c`
* 對應的憑證 JSON（`~/.cloudflared/<UUID>.json`）

### 5.4 為 Tunnel 建立 DNS（例如 `api.b1122333.com`）

```bash
cloudflared tunnel route dns my-llm api.b1122333.com
```

Cloudflare 會自動幫你建立一條 CNAME，
`api.b1122333.com → <UUID>.cfargotunnel.com`。

### 5.5 撰寫 `config.yml`：把外部 Host 導到本地 `5857`

建立 / 編輯 `~/.cloudflared/config.yml`：

```yaml
tunnel: 6da0b7da-ec47-41f5-904c-601a8d68748c
credentials-file: /Users/你的帳號/.cloudflared/6da0b7da-ec47-41f5-904c-601a8d68748c.json

ingress:
  - hostname: api.b1122333.com
    service: http://localhost:5857
  - service: http_status:404   # 最後一條 catch-all 規則
```

注意 YAML 縮排須正確。Cloudflare 官方文件強調：**最後一條 ingress 規則必須匹配所有 URL（例如 `http_status:404`），否則會報錯**。

### 5.6 啟動 Tunnel

確保 `llama-server` 已經在本地 5857 跑著，然後：

```bash
cloudflared tunnel run my-llm
```

如果成功，會看到類似：

```text
INF Connection established
INF Route propagating, it may take up to 1 minute for your new route to become functional
```

### 5.7 從互聯網測試 `https://api.b1122333.com`

```bash
curl https://api.b1122333.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-local" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "user", "content": "Hello from the Internet via Cloudflare Tunnel" }
    ]
  }'
```

如果一切正常，你會得到與本地測試類似的 JSON 回應。

### 5.8 關於 Cloudflare Error 1033

如果在瀏覽器看到 **Error 1033: Argo Tunnel error**，通常代表：

> Cloudflare 找不到健康的 `cloudflared` 來接這條 Tunnel。

排查步驟：

1. 確認 `cloudflared tunnel run my-llm` 是否有在跑
2. 使用：

   ```bash
   cloudflared tunnel list
   ```

   看該 tunnel 是否 `HEALTHY`
3. 確認 `config.yml` 中 `tunnel` ID 與憑證檔路徑無誤

---

## 6. Step 3：用 Cloudflare WAF 做「輕量版 API Key」(選配)

這一段是**比較輕量級**的保護：在 Cloudflare 邊緣用 WAF Rule 檢查一個自訂 Header，
有點像「門口問暗號」。

### 6.1 設計一個簡單的 Header Key

例如：

* Header 名：`X-My-LLM-Key`
* Header 值：`tno-llm-2025-secret`

之後所有合法請求都必須帶上：

```http
X-My-LLM-Key: tno-llm-2025-secret
```

### 6.2 WAF Expression 範例

在 Cloudflare WAF → Custom rules / Firewall rules 中新增一條規則：

* 條件（Expression）：

  ```txt
  (http.host eq "api.b1122333.com" and
   all(http.request.headers["x-my-llm-key"][*] ne "tno-llm-2025-secret"))
  ```

* Action：`Block`

語意是：

> 如果 Host 是 `api.b1122333.com`，
> 而且所有 `X-My-LLM-Key` 的值都 ≠ 你設定的 secret，
> 就 Block。

當 header 不存在或值錯誤時，這條規則會觸發，請求會被 Cloudflare 擋在邊緣，不會打到你的主機。

### 6.3 測試

**錯誤（沒帶 key）：**

```bash
curl https://api.b1122333.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-local" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "user", "content": "no key" }
    ]
  }'
```

→ 應該被 Cloudflare 拒絕（403 / Access denied）。

**正確（帶對 key）：**

```bash
curl https://api.b1122333.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-local" \
  -H "X-My-LLM-Key: tno-llm-2025-secret" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "user", "content": "with key" }
    ]
  }'
```

→ 應該能正常拿到 LLM 回覆。

> ⚠️ 這種做法比較適合「自用 / 小範圍使用」。
> 如果要像 OpenAI 一樣管理多個 API Key / 限流 / 綁帳號，就需要下一步的 **Node.js Gateway**。

---

## 7. Step 4：用 Node.js 實作「類 OpenAI API Key 系統」

這一節是核心：做一個**真正像 OpenAI 那樣**的 API Gateway。

### 7.1 新架構

```text
Client / App
  ↓  HTTPS (Cloudflare → Tunnel)
api.b1122333.com
  ↓
Node.js Gateway (localhost:8787)
  - 驗證 Authorization: Bearer sk-xxx
  - 管理 API Keys
  ↓
llama-server (localhost:5857)
```

Cloudflare 的 ingress 不再直接指向 5857，而是指向 8787。

### 7.2 建立 Node.js 專案

```bash
mkdir my-llm-gateway
cd my-llm-gateway

npm init -y
npm install express dotenv
```

在 `package.json` 加上：

```json
{
  "name": "my-llm-gateway",
  "version": "1.0.0",
  "main": "gateway.js",
  "type": "module",
  "scripts": {
    "start": "node gateway.js"
  },
  "dependencies": {
    "dotenv": "^16.4.0",
    "express": "^4.21.0"
  }
}
```

### 7.3 使用 `.env` 管理 API Key & 上游地址

建立 `.env`：

```env
# 允許的 API Keys（可以多個，用逗號分隔）
LLM_API_KEYS=sk-tno-llm-2025-1,sk-tno-llm-2025-2

# llama-server 的 HTTP 位址
LLM_UPSTREAM=http://127.0.0.1:5857

# Gateway 監聽的本機 port
GATEWAY_PORT=8787
```

### 7.4 `gateway.js`：API Key 驗證 + 轉發

```js
// gateway.js
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// env 配置
const PORT = process.env.GATEWAY_PORT
  ? parseInt(process.env.GATEWAY_PORT, 10)
  : 8787;
const UPSTREAM_BASE = process.env.LLM_UPSTREAM || "http://127.0.0.1:5857";

// 解析 API Key 列表
const rawKeys = (process.env.LLM_API_KEYS || "").split(",");
const VALID_KEYS = new Set(
  rawKeys.map(k => k.trim()).filter(k => k.length > 0)
);

console.log("✅ LLM Gateway starting with config:");
console.log("  - Port:", PORT);
console.log("  - Upstream:", UPSTREAM_BASE);
console.log("  - Valid API keys:", VALID_KEYS.size);

// 解析 JSON body
app.use(express.json({ limit: "10mb" }));

// --- 中間件：驗證 API Key（OpenAI 風格） ---
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(401).json({
      error: {
        message: "Missing Authorization header. Use: Authorization: Bearer sk-xxxx",
        type: "invalid_api_key"
      }
    });
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return res.status(401).json({
      error: {
        message: "Invalid Authorization header format. Expected: Bearer sk-xxxx",
        type: "invalid_api_key"
      }
    });
  }

  const token = parts[1].trim();

  if (!VALID_KEYS.has(token)) {
    console.warn("❌ Invalid API key:", token);
    return res.status(401).json({
      error: {
        message: "Incorrect API key provided.",
        type: "invalid_api_key"
      }
    });
  }

  // 通過驗證
  req.apiKey = token;
  next();
}

// --- Health check ---
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    upstream: UPSTREAM_BASE,
    keysConfigured: VALID_KEYS.size
  });
});

// --- Chat Completions 代理 ---
app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
  try {
    const upstreamUrl = `${UPSTREAM_BASE}/v1/chat/completions`;

    console.log("➡️  /v1/chat/completions via key:", req.apiKey);

    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });

    res.status(upstreamRes.status);
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.toLowerCase() === "transfer-encoding") continue;
      res.setHeader(key, value);
    }

    if (upstreamRes.body) {
      upstreamRes.body.pipe(res); // 支援 streaming
    } else {
      res.end();
    }
  } catch (err) {
    console.error("Gateway error:", err);
    res.status(500).json({
      error: {
        message: "Gateway failed to reach llama-server.",
        type: "gateway_error"
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 LLM API Gateway listening on http://localhost:${PORT}`);
  console.log("   Try: curl http://localhost:" + PORT + "/health");
});
```

### 7.5 本地測試 Gateway

1. 確保 `llama-server` 在 5857 正常服務

2. 啟動 Gateway：

   ```bash
   npm start
   # or
   # node gateway.js
   ```

3. 測試健康檢查：

   ```bash
   curl http://localhost:8787/health
   ```

4. 使用**正確 API Key** 測試 chat：

   ```bash
   curl http://localhost:8787/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer sk-tno-llm-2025-1" \
     -d '{
       "model": "gpt-oss-20b",
       "messages": [
         { "role": "user", "content": "Hello via Node.js Gateway" }
       ]
     }'
   ```

5. 測試錯誤 key / 無 key：

   * 沒有 `Authorization` header
   * 或 `Authorization: Bearer sk-wrong-key`

   應該會得到類似：

   ```json
   {
     "error": {
       "message": "Incorrect API key provided.",
       "type": "invalid_api_key"
     }
   }
   ```

這時，你已經有一個真正的 **OpenAI-style API Key system**：
所有客戶端都必須帶 `Authorization: Bearer sk-...`，
Gateway 會在前面做驗證。

### 7.6 把 Cloudflare Tunnel 指到 Gateway（公開出去）

再次編輯 `~/.cloudflared/config.yml`：

```yaml
tunnel: 6da0b7da-ec47-41f5-904c-601a8d68748c
credentials-file: /Users/你/.cloudflared/6da0b7da-ec47-41f5-904c-601a8d68748c.json

ingress:
  - hostname: api.b1122333.com
    service: http://localhost:8787   # ← 改成 Gateway port
  - service: http_status:404
```

重新啟動 Tunnel：

```bash
cloudflared tunnel run my-llm
```

然後從互聯網測試：

```bash
curl https://api.b1122333.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-tno-llm-2025-1" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "user", "content": "Hello from Internet via Gateway + API Key" }
    ]
  }'
```

到這裡，你已經完成：

> 「在家自架一個有 API Key、OpenAI 風格的 LLM API，透過 Cloudflare 安全公開到外面。」

---

## 8. 優點、限制與風險評估

### 8.1 優點（Pros）

* ✅ **成本可控**：沒有雲端 token 費，只有電費 + 硬體成本
* ✅ **隱私較佳**：資料在自己機器上處理，不必上傳到第三方
* ✅ **高度自由度**：可換不同開源模型、調整推理設定、加上自訂工具 / RAG 等
* ✅ **API 介面兼容**：`/v1/chat/completions` 等與 OpenAI 接近，很多 SDK / 工具可直接換 endpoint 使用

### 8.2 限制（Limitations）

* ⚠️ 效能依賴你自己的 CPU / GPU / RAM
* ⚠️ 沒有「官方」的高可用、多機負載均衡
* ⚠️ 模型能力可能不及 GPT-4.1 / GPT-5 這種大型雲端模型，在推理品質、工具能力上會有差異

### 8.3 風險（Risks）

* ⚠️ 你的電腦 = Server

  * 斷電、斷網、關機 → 服務中斷
* ⚠️ 安全性

  * 若 API 對外公開且沒有限制，有可能被濫用（把你的機器算力用光）
  * 建議至少要：

    * 使用 API Key Gateway（如本文 Node.js 實作）
    * 搭配 Cloudflare WAF / Rate Limit
* ⚠️ 法規與內容風險

  * 自架模型生成的內容仍然可能有法律 / 合規問題
  * 特別是如果你讓第三方用這個服務，要考慮風險分攤與使用條款

---

## 9. 可以延伸發展的方向

如果要把這個 Demo 變成「產品等級」的服務，可以繼續演進：

1. **API Key 管理後台**

   * 建立資料庫（例如 Postgres 或 SQLite）存 API Keys
   * 提供簡單的 Web UI 建立 / 停用 / 註解 key

2. **使用量與限流**

   * 在 Gateway 裡面紀錄每個 key 的請求次數 / token 數
   * 加入簡單的限流（每分鐘 N 次 / 每天 N tokens）

3. **模型選擇與路由**

   * 同一個 Gateway 下掛多個模型（7B, 20B, 120B）
   * 依照 `model` 名稱或 header 路由不同上游

4. **結合 RAG、企業內部資料**

   * 在 Gateway 前面再加一層「Retrieval 層」，
   * 將查詢送往向量資料庫 / 檔案系統，
   * 把 context 帶入 `llama-server`

---

## 10. 結語：在家打造自己的「迷你 OpenAI」

總結一下這套架構提供的價值：

* `llama-server` 給你一個 **OpenAI 風格的本地 LLM 引擎**
* Cloudflare Tunnel 幫你安全地把本地服務暴露到公網，**無需 Port Forwarding**
* Node.js API Gateway 則讓你擁有一套
  **真正「Authorization: Bearer sk-xxx」的 API Key 機制**

你可以用這份報告作為：

* 自己博客文章的底稿
* 給團隊 / 同事看的「技術方案說明」
* 未來延伸成更完整的「自建 LLM 平台」系列文章

接下來你可以在自己的 Blog 上：

* 加入實際截圖（Cloudflare 後台、Terminal log）
* 補上你自己的使用體驗、效能測試
* 或加入中文讀者比較喜歡的故事化敘事，把整個流程講成一個 side project 的打造過程。
