// Lightweight OpenAI-style gateway with API key enforcement.
import express from "express";
import { Readable } from "node:stream";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.GATEWAY_PORT
  ? parseInt(process.env.GATEWAY_PORT, 10)
  : 8787;
const UPSTREAM_BASE = process.env.LLM_UPSTREAM || "http://127.0.0.1:5857";
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "*";
const CORS_ALLOW_HEADERS =
  "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-My-LLM-Key";
const CORS_ALLOW_METHODS = "GET, POST, OPTIONS";

const rawKeys = (process.env.LLM_API_KEYS || "").split(",");
const VALID_KEYS = new Set(
  rawKeys.map((k) => k.trim()).filter((k) => k.length > 0)
);

console.log("✅ LLM Gateway starting with config:");
console.log("  - Port:", PORT);
console.log("  - Upstream:", UPSTREAM_BASE);
console.log("  - Valid API keys:", VALID_KEYS.size);
console.log("  - CORS allow origin:", CORS_ALLOW_ORIGIN);

app.use(express.json({ limit: "10mb" }));

// Basic CORS handling so browsers can call the gateway.
app.use((req, res, next) => {
  applyCors(res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(401).json({
      error: {
        message: "Missing Authorization header. Use: Authorization: Bearer sk-xxxx",
        type: "invalid_api_key",
      },
    });
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return res.status(401).json({
      error: {
        message: "Invalid Authorization header format. Expected: Bearer sk-xxxx",
        type: "invalid_api_key",
      },
    });
  }

  const token = parts[1].trim();

  if (!VALID_KEYS.has(token)) {
    console.warn("❌ Invalid API key:", token);
    return res.status(401).json({
      error: {
        message: "Incorrect API key provided.",
        type: "invalid_api_key",
      },
    });
  }

  req.apiKey = token;
  next();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    upstream: UPSTREAM_BASE,
    keysConfigured: VALID_KEYS.size,
  });
});

app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
  try {
    const upstreamUrl = `${UPSTREAM_BASE}/v1/chat/completions`;
    console.log("➡️  /v1/chat/completions via key:", req.apiKey);

    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    res.status(upstreamRes.status);
    for (const [key, value] of upstreamRes.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === "transfer-encoding") continue;
      if (lowerKey.startsWith("access-control-")) continue;
      res.setHeader(key, value);
    }
    applyCors(res);

    if (!upstreamRes.body) return res.end();

    // Convert Web stream -> Node stream for piping to Express response.
    Readable.fromWeb(upstreamRes.body).pipe(res);
  } catch (err) {
    console.error("Gateway error:", err);
    res.status(500).json({
      error: {
        message: "Gateway failed to reach llama-server.",
        type: "gateway_error",
      },
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 LLM API Gateway listening on http://localhost:${PORT}`);
  console.log("   Try: curl http://localhost:" + PORT + "/health");
});

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
}
