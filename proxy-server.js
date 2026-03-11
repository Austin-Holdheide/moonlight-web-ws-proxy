/**
 * moonlight-web-ws-proxy  v2.0
 *
 * What moonlight-web-stream actually is:
 *   - A self-contained Rust web server (default port 8080) that runs ON the
 *     gaming PC alongside Sunshine.
 *   - It serves a SPA web frontend at GET /
 *   - All REST API calls go to /api/...  (user login, host management, app list)
 *   - Stream negotiation happens over a WebSocket at  /api/host/stream
 *     (this is the WebRTC signaling channel — SDP offer/answer + ICE candidates)
 *   - Actual A/V data flows peer-to-peer via WebRTC, NOT through this proxy
 *
 * What this proxy does:
 *   - Accepts a WebSocket connection from client.html (offline file://)
 *   - Forwards all HTTP requests  →  moonlight-web-stream HTTP API
 *   - Transparently bridges the  /api/host/stream  WebSocket upgrade
 *     so the browser's WebRTC signaling reaches the Rust streamer
 *   - Passes binary bodies (images, etc.) as base64
 *
 * The iframe injection approach from v1 is NOT needed:
 *   Instead client.html loads the moonlight SPA assets through this proxy
 *   and replaces fetch/XHR/WebSocket so they route through the WS tunnel.
 */

const http  = require("http");
const https = require("https");
const { WebSocketServer, WebSocket } = require("ws");
const url   = require("url");

const PORT = process.env.PORT || 8765;

// ─── HTTP server (health + WS upgrade point) ──────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "moonlight-web-ws-proxy", version: "2.0.0" }));
});

// ─── Control WebSocket (client.html ↔ proxy) ──────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (clientWs, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[+] client connected  ${ip}`);

  // Per-connection state
  let targetOrigin = null;          // e.g. "https://moon.holdheide.com:8080"
  let streamWs     = null;          // upstream /api/host/stream WebSocket

  // ── Helpers ─────────────────────────────────────────────────────────────

  function send(obj) {
    if (clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify(obj));
  }

  function resolveUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    if (rawUrl.startsWith("http")) return rawUrl;
    const slash = rawUrl.startsWith("/") ? "" : "/";
    return (targetOrigin || "") + slash + rawUrl;
  }

  /**
   * Proxy one HTTP request to the moonlight-web-stream server.
   * Cookies/auth headers are forwarded verbatim so session tokens work.
   */
  function proxyHttp(reqUrl, method, headers, body) {
    return new Promise((resolve, reject) => {
      const parsed   = new URL(reqUrl);
      const isHttps  = parsed.protocol === "https:";
      const lib      = isHttps ? https : http;

      // Strip hop-by-hop headers
      const safe = Object.fromEntries(
        Object.entries(headers || {}).filter(([k]) =>
          !["host","connection","upgrade","proxy-connection",
            "transfer-encoding","keep-alive"].includes(k.toLowerCase())
        )
      );
      safe["host"] = parsed.host;

      // Content-Length for bodies
      let bodyBuf = null;
      if (body) {
        bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        safe["content-length"] = bodyBuf.length;
      }

      const opts = {
        hostname:           parsed.hostname,
        port:               parsed.port || (isHttps ? 443 : 80),
        path:               parsed.pathname + parsed.search,
        method:             (method || "GET").toUpperCase(),
        headers:            safe,
        rejectUnauthorized: false,  // Sunshine often uses self-signed TLS
      };

      const proxyReq = lib.request(opts, proxyRes => {
        const chunks = [];
        proxyRes.on("data",  c => chunks.push(c));
        proxyRes.on("end",   () => {
          const buf = Buffer.concat(chunks);
          const ct  = proxyRes.headers["content-type"] || "";

          // Decide encoding: text/json/html/xml as utf8, rest as base64
          const isText =
            ct.includes("text/")       ||
            ct.includes("application/json") ||
            ct.includes("application/xml")  ||
            ct.includes("javascript")       ||
            ct.includes("css");

          resolve({
            status:   proxyRes.statusCode,
            headers:  proxyRes.headers,
            body:     isText ? buf.toString("utf8") : buf.toString("base64"),
            encoding: isText ? "utf8" : "base64",
          });
        });
        proxyRes.on("error", reject);
      });

      proxyReq.on("error", reject);
      if (bodyBuf) proxyReq.write(bodyBuf);
      proxyReq.end();
    });
  }

  /**
   * Open and bridge the /api/host/stream WebSocket.
   * This is the WebRTC signaling channel — the proxy must be transparent here.
   * Messages are JSON (SDP offer/answer, ICE candidates) sent by the Rust
   * streamer subprocess and the browser's moonlight-common-web JS library.
   */
  function openStreamWs(streamWsUrl, protocols) {
    if (streamWs) { streamWs.close(); streamWs = null; }

    console.log(`[~] opening stream WS → ${streamWsUrl}`);
    const upstream = new WebSocket(streamWsUrl, protocols || [], {
      rejectUnauthorized: false,
      headers: { "origin": targetOrigin || "null" },
    });

    upstream.on("open", () => {
      console.log(`[✓] stream WS open`);
      send({ type: "stream_ws_open" });
    });

    // Forward every frame verbatim – these are binary or JSON WebRTC signals
    upstream.on("message", (data, isBinary) => {
      if (isBinary) {
        // send as base64 so we can stay inside JSON envelope
        send({ type: "stream_ws_message", data: data.toString("base64"), binary: true });
      } else {
        send({ type: "stream_ws_message", data: data.toString("utf8"), binary: false });
      }
    });

    upstream.on("close", (code, reason) => {
      console.log(`[~] stream WS closed ${code}`);
      send({ type: "stream_ws_closed", code, reason: reason.toString() });
      streamWs = null;
    });

    upstream.on("error", err => {
      console.error(`[!] stream WS error: ${err.message}`);
      send({ type: "stream_ws_error", message: err.message });
    });

    streamWs = upstream;
  }

  // ── Message Router ───────────────────────────────────────────────────────
  clientWs.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { send({ type: "error", message: "invalid JSON" }); return; }

    switch (msg.type) {

      // ── CONNECT ─────────────────────────────────────────────────────────
      // Called once on startup with the moonlight-web-stream base URL.
      // The proxy probes / and /api/user/info to confirm it's alive.
      case "connect": {
        let raw = (msg.url || "").replace(/\/+$/, "");
        if (!raw) { send({ type: "error", message: "no url" }); return; }
        if (!raw.startsWith("http")) raw = "https://" + raw;
        targetOrigin = raw;

        console.log(`[>] target → ${targetOrigin}`);

        try {
          // Fetch the SPA index — confirms web server is up
          const root = await proxyHttp(targetOrigin + "/", "GET", { accept: "text/html" }, null);

          // Try the user-info endpoint to see if we need auth
          let userInfo = null;
          try {
            const ui = await proxyHttp(
              targetOrigin + "/api/user/info", "GET",
              { accept: "application/json" }, null
            );
            if (ui.status === 200) userInfo = JSON.parse(ui.body);
          } catch {}

          send({
            type:       "connected",
            origin:     targetOrigin,
            rootStatus: root.status,
            userInfo,   // null → need to log in first
          });
        } catch (err) {
          send({ type: "error", message: `cannot reach target: ${err.message}` });
          targetOrigin = null;
        }
        break;
      }

      // ── HTTP REQUEST ─────────────────────────────────────────────────────
      // The client-side fetch/XHR override sends every API call here.
      // Endpoint examples:
      //   POST /api/user/login      { username, password }
      //   GET  /api/host            list saved hosts
      //   POST /api/host            add a host
      //   GET  /api/host/:id/apps   list apps for a host
      //   POST /api/host/:id/pair   start pairing (returns PIN)
      //   GET  /api/host/:id/stream (HTTP→WS upgrade — handled separately below)
      case "request": {
        const reqUrl = resolveUrl(msg.url);
        if (!reqUrl) {
          send({ type: "response", id: msg.id, error: "no url" });
          return;
        }
        console.log(`[→] ${(msg.method||"GET").padEnd(6)} ${reqUrl}`);
        try {
          const r = await proxyHttp(reqUrl, msg.method, msg.headers, msg.body);
          send({ type: "response", id: msg.id,
            status: r.status, headers: r.headers, body: r.body, encoding: r.encoding });
        } catch (err) {
          send({ type: "response", id: msg.id, error: err.message });
        }
        break;
      }

      // ── STREAM_WS_OPEN ───────────────────────────────────────────────────
      // Opens the /api/host/stream WebSocket — the WebRTC signaling channel.
      // The client sends this right before starting a stream session.
      // msg.url  — full ws(s):// URL or a path like /api/host/stream?...
      case "stream_ws_open": {
        const wsUrl = resolveUrl(msg.url)
          .replace(/^https?:/, proto => proto.replace("http", "ws"));
        openStreamWs(wsUrl, msg.protocols);
        break;
      }

      // ── STREAM_WS_SEND ───────────────────────────────────────────────────
      // Forward a WebRTC signal frame upstream (SDP / ICE candidate JSON).
      case "stream_ws_send": {
        if (!streamWs || streamWs.readyState !== WebSocket.OPEN) {
          send({ type: "error", message: "stream WS not open" });
          return;
        }
        if (msg.binary) {
          streamWs.send(Buffer.from(msg.data, "base64"), { binary: true });
        } else {
          streamWs.send(msg.data);
        }
        break;
      }

      // ── STREAM_WS_CLOSE ──────────────────────────────────────────────────
      case "stream_ws_close": {
        if (streamWs) { streamWs.close(); streamWs = null; }
        break;
      }

      // ── PING ─────────────────────────────────────────────────────────────
      case "ping":
        send({ type: "pong", ts: Date.now() });
        break;

      default:
        send({ type: "error", message: `unknown type: ${msg.type}` });
    }
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────
  clientWs.on("close", () => {
    console.log(`[-] client disconnected`);
    if (streamWs) { streamWs.close(); streamWs = null; }
  });

  clientWs.on("error", err => console.error(`[!] client WS error: ${err.message}`));

  send({ type: "ready", version: "2.0.0" });
});

// ─── Start ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║  moonlight-web-ws-proxy  v2.0                     ║
║                                                   ║
║  WS control channel : ws://localhost:${PORT}        ║
║  Health check       : http://localhost:${PORT}      ║
║                                                   ║
║  Point client.html at this proxy, then enter      ║
║  your moonlight-web-stream URL (e.g.              ║
║  https://moon.holdheide.com:8080)                 ║
╚═══════════════════════════════════════════════════╝
`);
});