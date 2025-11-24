// Lightweight OpenAI-style gateway with API key enforcement.
import express from "express";
import { Readable } from "node:stream";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.GATEWAY_PORT
  ? parseInt(process.env.GATEWAY_PORT, 10)
  : 8787;
const DEFAULT_UPSTREAM = process.env.LLM_UPSTREAM || "http://127.0.0.1:5857";
const UPSTREAM_LIST = parseList(process.env.LLM_UPSTREAMS);
const SERVER_MAX_CONCURRENT = (() => {
  const raw = process.env.LLM_SERVER_MAX_CONCURRENT;
  if (!raw) return 1;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 1;
  return parsed;
})();
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "*";
const CORS_ALLOW_HEADERS =
  "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-My-LLM-Key";
const CORS_ALLOW_METHODS = "GET, POST, OPTIONS";
const HEARTBEAT_INTERVAL_MS = process.env.GATEWAY_HEARTBEAT_MS
  ? parseInt(process.env.GATEWAY_HEARTBEAT_MS, 10)
  : 15000;
const MAX_CONCURRENT_REQUESTS = (() => {
  const raw = process.env.GATEWAY_MAX_CONCURRENT;
  if (!raw) return Infinity;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? Infinity : parsed;
})();
const CONCURRENCY_ENABLED =
  Number.isFinite(MAX_CONCURRENT_REQUESTS) && MAX_CONCURRENT_REQUESTS > 0;
const defaultBusyMessage = CONCURRENCY_ENABLED
  ? `Currently more than ${MAX_CONCURRENT_REQUESTS} users are active. Please try again later.`
  : "Gateway is fully occupied. Please try again later.";
const GATEWAY_BUSY_MESSAGE =
  process.env.GATEWAY_BUSY_MESSAGE || defaultBusyMessage;
const MAX_PENDING_QUEUE = (() => {
  const raw = process.env.GATEWAY_MAX_QUEUE;
  if (!raw) return 25;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 25;
  if (parsed <= 0) return Infinity;
  return parsed;
})();
const upstreamPools = (UPSTREAM_LIST.length ? UPSTREAM_LIST : [DEFAULT_UPSTREAM]).map(
  (base, index) => ({
    id: index,
    base,
    active: 0,
    limit: SERVER_MAX_CONCURRENT > 0 ? SERVER_MAX_CONCURRENT : Infinity,
  })
);
let upstreamCursor = -1;
const pendingRequests = [];

const rawKeys = (process.env.LLM_API_KEYS || "").split(",");
const VALID_KEYS = new Set(
  rawKeys.map((k) => k.trim()).filter((k) => k.length > 0)
);

let activeChatRequests = 0;

console.log("✅ LLM Gateway starting with config:");
console.log("  - Port:", PORT);
console.log(
  "  - Upstreams:",
  upstreamPools.map((u) => `${u.base} (max ${u.limit})`).join(", ")
);
console.log("  - Valid API keys:", VALID_KEYS.size);
console.log("  - CORS allow origin:", CORS_ALLOW_ORIGIN);
if (CONCURRENCY_ENABLED) {
  console.log("  - Max concurrent chat completions:", MAX_CONCURRENT_REQUESTS);
} else {
  console.log("  - Max concurrent chat completions: unlimited");
}
if (Number.isFinite(MAX_PENDING_QUEUE)) {
  console.log("  - Max queued requests:", MAX_PENDING_QUEUE);
} else {
  console.log("  - Max queued requests: unlimited");
}

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
    upstreams: upstreamPools.map((u) => ({
      base: u.base,
      active: u.active,
      limit: Number.isFinite(u.limit) ? u.limit : null,
    })),
    keysConfigured: VALID_KEYS.size,
  });
});

app.post("/v1/chat/completions", authMiddleware, (req, res) => {
  handleChatCompletion(req, res);
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

function startHeartbeat(res, payload) {
  if (!HEARTBEAT_INTERVAL_MS || HEARTBEAT_INTERVAL_MS <= 0) {
    return () => {};
  }

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || res.writableEnded) {
      clearInterval(timer);
      return;
    }
    try {
      res.write(payload);
    } catch (err) {
      console.warn("Heartbeat write failed:", err.message || err);
      clearInterval(timer);
    }
  }, HEARTBEAT_INTERVAL_MS);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

function handleChatCompletion(req, res) {
  if (CONCURRENCY_ENABLED) {
    const totalInFlight = activeChatRequests + pendingRequests.length;
    if (totalInFlight >= MAX_CONCURRENT_REQUESTS) {
      console.warn(
        "⛔ Gateway overloaded. Active:",
        activeChatRequests,
        "Queued:",
        pendingRequests.length,
        "Limit:",
        MAX_CONCURRENT_REQUESTS
      );
      return sendBusyResponse(res);
    }
  }

  const context = { req, res };
  if (dispatchToAvailableServer(context)) {
    return;
  }

  if (pendingRequests.length >= MAX_PENDING_QUEUE) {
    console.warn(
      "🚫 Queue full. Pending:",
      pendingRequests.length,
      "Limit:",
      MAX_PENDING_QUEUE
    );
    return sendBusyResponse(res);
  }

  queueRequest(context);
}

function sendBusyResponse(res) {
  return res.status(429).json({
    error: {
      message: GATEWAY_BUSY_MESSAGE,
      type: "rate_limit_exceeded",
    },
  });
}

function dispatchToAvailableServer(context) {
  const upstream = findAvailableUpstream();
  if (!upstream) {
    return false;
  }
  startProxyRequest(context, upstream);
  return true;
}

function queueRequest(context) {
  context.queued = true;
  context.queueCleanup = () => removeFromQueue(context);
  context.res.once("close", context.queueCleanup);
  context.res.once("error", context.queueCleanup);
  pendingRequests.push(context);
  console.log(
    "⏳ Request queued. Queue length:",
    pendingRequests.length,
    "Active:",
    activeChatRequests
  );
}

function removeFromQueue(context) {
  if (!context.queued) return;
  context.queued = false;
  if (context.queueCleanup) {
    context.res.off("close", context.queueCleanup);
    context.res.off("error", context.queueCleanup);
    context.queueCleanup = null;
  }
  const idx = pendingRequests.indexOf(context);
  if (idx !== -1) {
    pendingRequests.splice(idx, 1);
  }
}

function processQueue() {
  while (pendingRequests.length > 0) {
    const upstream = findAvailableUpstream();
    if (!upstream) return;
    const next = pendingRequests.shift();
    if (!next) continue;
    removeFromQueue(next);
    if (next.res.writableEnded || next.res.destroyed) {
      continue;
    }
    startProxyRequest(next, upstream);
  }
}

function findAvailableUpstream() {
  if (!upstreamPools.length) {
    return null;
  }
  const total = upstreamPools.length;
  for (let i = 0; i < total; i += 1) {
    upstreamCursor = (upstreamCursor + 1) % total;
    const candidate = upstreamPools[upstreamCursor];
    if (candidate.active < candidate.limit) {
      return candidate;
    }
  }
  return null;
}

function startProxyRequest(context, upstream) {
  if (context.queueCleanup) {
    context.res.off("close", context.queueCleanup);
    context.res.off("error", context.queueCleanup);
    context.queueCleanup = null;
  }

  const res = context.res;
  const controller = new AbortController();
  const abortUpstream = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const release = createReleaseTracker(res, upstream, {
    onRelease: () => {
      res.off("close", abortUpstream);
      res.off("error", abortUpstream);
    },
  });

  res.on("close", abortUpstream);
  res.on("error", abortUpstream);

  proxyToUpstream(context, upstream, controller).catch((err) => {
    if (err?.name === "AbortError") {
      console.warn("🔌 Upstream aborted (client disconnected).");
      release();
      return;
    }
    console.error("Gateway proxy error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: "Gateway failed to reach llama-server.",
          type: "gateway_error",
        },
      });
    } else {
      res.end();
    }
    release();
  });
}

function createReleaseTracker(res, upstream, options = {}) {
  activeChatRequests += 1;
  upstream.active += 1;
  let released = false;
  const { onRelease } = options || {};

  const release = () => {
    if (released) return;
    released = true;
    activeChatRequests = Math.max(0, activeChatRequests - 1);
    upstream.active = Math.max(0, upstream.active - 1);
    res.off("close", release);
    res.off("finish", release);
    res.off("error", release);
    if (typeof onRelease === "function") {
      try {
        onRelease();
      } catch (err) {
        console.warn("Release cleanup failed:", err);
      }
    }
    processQueue();
  };

  res.on("close", release);
  res.on("finish", release);
  res.on("error", release);

  return release;
}

async function proxyToUpstream(context, upstream, controller) {
  const { req, res } = context;
  const upstreamUrl = `${upstream.base}/v1/chat/completions`;
  console.log(
    "➡️  /v1/chat/completions via key:",
    req.apiKey,
    "->",
    upstream.base
  );

  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
    signal: controller?.signal,
  });

  res.status(upstreamRes.status);
  for (const [key, value] of upstreamRes.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "transfer-encoding") continue;
    if (lowerKey.startsWith("access-control-")) continue;
    res.setHeader(key, value);
  }
  if (!res.getHeader("Cache-Control")) {
    res.setHeader("Cache-Control", "no-cache");
  }
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const contentType =
    upstreamRes.headers.get("content-type") || "application/json";
  if (!res.getHeader("Content-Type")) {
    res.setHeader("Content-Type", contentType);
  }
  applyCors(res);

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const isEventStream = contentType.toLowerCase().includes("text/event-stream");
  const stopHeartbeat = startHeartbeat(
    res,
    isEventStream ? ": keep-alive\n\n" : " "
  );

  if (!upstreamRes.body) {
    stopHeartbeat();
    res.end();
    return;
  }

  const upstreamStream = Readable.fromWeb(upstreamRes.body);
  const abortStream = () => {
    try {
      upstreamStream.destroy(
        new Error("Client disconnected; upstream stream aborted.")
      );
    } catch (err) {
      console.warn("Failed to destroy upstream stream:", err?.message || err);
    }
  };
  if (controller?.signal) {
    controller.signal.addEventListener("abort", abortStream);
  }
  const cleanupHeartbeat = () => {
    stopHeartbeat();
    if (controller?.signal) {
      controller.signal.removeEventListener("abort", abortStream);
    }
  };
  upstreamStream.once("data", cleanupHeartbeat);
  upstreamStream.once("end", cleanupHeartbeat);
  upstreamStream.once("error", cleanupHeartbeat);
  res.once("close", cleanupHeartbeat);
  upstreamStream.pipe(res);
}

function parseList(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
