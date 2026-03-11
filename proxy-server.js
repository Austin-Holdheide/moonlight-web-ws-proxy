/**
 * moonlight-web-ws-proxy
 * WebSocket proxy server for moonlight-web-stream
 * Bridges an offline HTML client to any moonlight/sunshine web instance
 */

const http = require("http");
const https = require("https");
const { WebSocketServer, WebSocket } = require("ws");
const url = require("url");
const { EventEmitter } = require("events");

const PORT = process.env.PORT || 8765;

// ─── HTTP Server (health check + WS upgrade) ──────────────────────────────
const httpServer = http.createServer((req, res) => {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ status: "moonlight-web-ws-proxy", version: "1.0.0" })
  );
});

// ─── WebSocket Server ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (clientWs, req) => {
  const clientIp =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[+] Client connected from ${clientIp}`);

  let targetOrigin = null; // e.g. https://moon.holdheide.com
  let targetWs = null; // upstream WS (if moonlight uses WS for stream signaling)
  const pendingRequests = new Map(); // id → { resolve, reject }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function send(obj) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(obj));
    }
  }

  function normalizeUrl(rawUrl) {
    // If path-relative, prepend the target origin
    if (!rawUrl.startsWith("http")) {
      return targetOrigin + (rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl);
    }
    return rawUrl;
  }

  function proxyFetch(fetchUrl, method, headers, body) {
    return new Promise((resolve, reject) => {
      const parsed = url.parse(fetchUrl);
      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;

      // Strip hop-by-hop headers that break proxying
      const safeHeaders = { ...headers };
      [
        "host",
        "connection",
        "upgrade",
        "proxy-connection",
        "transfer-encoding",
      ].forEach((h) => delete safeHeaders[h]);
      safeHeaders["host"] = parsed.host;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.path || "/",
        method: method || "GET",
        headers: safeHeaders,
        rejectUnauthorized: false, // allow self-signed (common with Sunshine)
      };

      const proxyReq = lib.request(options, (proxyRes) => {
        const chunks = [];
        proxyRes.on("data", (d) => chunks.push(d));
        proxyRes.on("end", () => {
          const bodyBuf = Buffer.concat(chunks);
          // Detect binary vs text
          const ct = proxyRes.headers["content-type"] || "";
          const isBinary =
            ct.includes("image") ||
            ct.includes("octet-stream") ||
            ct.includes("video") ||
            ct.includes("audio");

          resolve({
            status: proxyRes.statusCode,
            headers: proxyRes.headers,
            body: isBinary
              ? bodyBuf.toString("base64")
              : bodyBuf.toString("utf8"),
            encoding: isBinary ? "base64" : "utf8",
          });
        });
        proxyRes.on("error", reject);
      });

      proxyReq.on("error", reject);

      if (body) {
        const bodyData =
          typeof body === "string" ? body : JSON.stringify(body);
        proxyReq.write(bodyData);
      }

      proxyReq.end();
    });
  }

  // Bridge an upstream WebSocket (for Sunshine's WS-based stream negotiation)
  function bridgeUpstreamWs(upstreamUrl) {
    if (targetWs) {
      targetWs.close();
      targetWs = null;
    }

    console.log(`[~] Bridging upstream WS → ${upstreamUrl}`);
    const upstream = new WebSocket(upstreamUrl, {
      rejectUnauthorized: false,
    });

    upstream.on("open", () => {
      send({ type: "ws_connected", url: upstreamUrl });
    });

    upstream.on("message", (data) => {
      send({ type: "ws_message", data: data.toString() });
    });

    upstream.on("close", (code, reason) => {
      send({ type: "ws_closed", code, reason: reason.toString() });
      targetWs = null;
    });

    upstream.on("error", (err) => {
      send({ type: "ws_error", message: err.message });
    });

    targetWs = upstream;
    return upstream;
  }

  // ── Message Handler ───────────────────────────────────────────────────────
  clientWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send({ type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {
      // ── CONNECT: set target origin, fetch server info ──────────────────
      case "connect": {
        const rawTarget = msg.url || "";
        if (!rawTarget) {
          send({ type: "error", message: "No target URL provided" });
          return;
        }

        // Normalize target URL
        targetOrigin = rawTarget.replace(/\/+$/, "");
        if (!targetOrigin.startsWith("http")) {
          // Auto-detect https/http: try https first
          targetOrigin = "https://" + targetOrigin;
        }

        console.log(`[>] Connecting to target: ${targetOrigin}`);

        try {
          // 1. Fetch the root page to confirm it's alive
          const rootResp = await proxyFetch(
            targetOrigin + "/",
            "GET",
            { accept: "text/html" },
            null
          );

          // 2. Try common Sunshine / GameStream server-info endpoints
          let serverInfo = null;
          const infoEndpoints = [
            "/serverinfo",
            "/api/serverinfo",
            "/moonlight/serverinfo",
          ];
          for (const ep of infoEndpoints) {
            try {
              const r = await proxyFetch(
                targetOrigin + ep,
                "GET",
                { accept: "application/json, text/xml, */*" },
                null
              );
              if (r.status === 200) {
                serverInfo = { endpoint: ep, raw: r.body, status: r.status };
                break;
              }
            } catch {}
          }

          send({
            type: "connected",
            origin: targetOrigin,
            rootStatus: rootResp.status,
            serverInfo,
          });

          console.log(`[✓] Connected to ${targetOrigin}`);
        } catch (err) {
          send({ type: "error", message: `Failed to reach target: ${err.message}` });
          targetOrigin = null;
        }
        break;
      }

      // ── HTTP REQUEST: proxy an arbitrary request to the target ─────────
      case "request": {
        if (!targetOrigin && !msg.url?.startsWith("http")) {
          send({
            type: "response",
            id: msg.id,
            error: "Not connected to a target",
          });
          return;
        }

        const reqUrl = normalizeUrl(msg.url);
        console.log(`[→] ${msg.method || "GET"} ${reqUrl}`);

        try {
          const result = await proxyFetch(
            reqUrl,
            msg.method || "GET",
            msg.headers || {},
            msg.body || null
          );
          send({
            type: "response",
            id: msg.id,
            status: result.status,
            headers: result.headers,
            body: result.body,
            encoding: result.encoding,
          });
        } catch (err) {
          send({
            type: "response",
            id: msg.id,
            error: err.message,
          });
        }
        break;
      }

      // ── WS_CONNECT: bridge a WebSocket to the upstream ────────────────
      case "ws_connect": {
        if (!msg.url) {
          send({ type: "error", message: "No WS URL provided" });
          return;
        }
        const wsUrl = normalizeUrl(msg.url).replace(/^http/, "ws");
        bridgeUpstreamWs(wsUrl);
        break;
      }

      // ── WS_SEND: forward data through the upstream WS ─────────────────
      case "ws_send": {
        if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
          send({ type: "error", message: "Upstream WS not connected" });
          return;
        }
        targetWs.send(msg.data);
        break;
      }

      // ── WS_CLOSE: close the upstream WS ───────────────────────────────
      case "ws_close": {
        if (targetWs) {
          targetWs.close();
          targetWs = null;
        }
        break;
      }

      // ── PING ──────────────────────────────────────────────────────────
      case "ping": {
        send({ type: "pong", ts: Date.now() });
        break;
      }

      default:
        send({ type: "error", message: `Unknown message type: ${msg.type}` });
    }
  });

  clientWs.on("close", () => {
    console.log(`[-] Client disconnected`);
    if (targetWs) {
      targetWs.close();
      targetWs = null;
    }
  });

  clientWs.on("error", (err) => {
    console.error(`[!] Client WS error: ${err.message}`);
  });

  // Send welcome
  send({ type: "ready", message: "moonlight-web-ws-proxy ready" });
});

// ─── Start ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   moonlight-web-ws-proxy  v1.0.0             ║
║   WebSocket: ws://localhost:${PORT}            ║
║   Health:    http://localhost:${PORT}           ║
╚══════════════════════════════════════════════╝
`);
});