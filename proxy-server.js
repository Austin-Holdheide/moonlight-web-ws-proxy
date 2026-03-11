/**
 * moonlight-web-ws-proxy  v3.0
 *
 * Key fixes over v2:
 *  - Force accept-encoding: identity on ALL requests (server uses zstd on
 *    everything — without this every response is garbled binary)
 *  - Per-connection cookie jar: captures mlSession from /api/login Set-Cookie
 *    and forwards it with every subsequent request automatically
 *  - Correct API surface from HAR analysis:
 *      GET  /api/authenticate   (200 = logged in, 401 = need login)
 *      POST /api/login          body: { name, password }   → Set-Cookie mlSession
 *      GET  /api/user
 *      GET  /api/hosts          (ndjson streaming — multiple JSON lines)
 *      GET  /api/host?host_id=X
 *      GET  /api/apps?host_id=X
 *      GET  /api/app/image?host_id=X&app_id=Y&force_refresh=false
 *      WS   /api/host/stream    (WebRTC signaling)
 */

const http  = require("http");
const https = require("https");
const { WebSocketServer, WebSocket } = require("ws");
const url   = require("url");

const PORT = process.env.PORT || 8765;

// ─── HTTP server ───────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "moonlight-web-ws-proxy", version: "3.0.0" }));
});

// ─── WebSocket server ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (clientWs, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[+] client  ${ip}`);

  // Per-connection state
  let targetOrigin = null;
  let streamWs     = null;

  // ── Cookie jar ───────────────────────────────────────────────────────────
  // Maps cookie name → value.  Populated from Set-Cookie response headers.
  // Forwarded as Cookie: header on every outgoing request.
  const cookieJar = {};

  function jarString() {
    return Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join("; ");
  }

  function absorbSetCookie(headers) {
    // headers is a plain object from Node's http.IncomingMessage.headers
    // set-cookie can be an array (multiple cookies) or a string
    const raw = headers["set-cookie"];
    if (!raw) return;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const line of list) {
      // "mlSession=abc123; HttpOnly; SameSite=Strict; Path=; Expires=..."
      const pair = line.split(";")[0].trim();
      const eq   = pair.indexOf("=");
      if (eq === -1) continue;
      const name  = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) {
        cookieJar[name] = value;
        console.log(`[🍪] stored cookie: ${name}`);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
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
   * Proxy one HTTP request.
   *
   * Critical: we inject `accept-encoding: identity` so the server NEVER
   * returns compressed (zstd/br/gzip) data.  Without this every response
   * is binary garbage.
   */
  function proxyHttp(reqUrl, method, reqHeaders, body) {
    return new Promise((resolve, reject) => {
      const parsed  = new URL(reqUrl);
      const isHttps = parsed.protocol === "https:";
      const lib     = isHttps ? https : http;

      // Build safe header set
      const safe = {};
      for (const [k, v] of Object.entries(reqHeaders || {})) {
        const kl = k.toLowerCase();
        // Drop hop-by-hop and problematic headers
        if (["host","connection","upgrade","proxy-connection",
             "transfer-encoding","keep-alive","te"].includes(kl)) continue;
        safe[k] = v;
      }

      safe["host"] = parsed.host;

      // ★ THE KEY FIX: never accept compressed responses
      safe["accept-encoding"] = "identity";

      // Inject stored session cookies on top of any cookies the client sent
      const jarStr = jarString();
      if (jarStr) {
        const existing = safe["cookie"] || safe["Cookie"] || "";
        safe["cookie"] = existing ? `${existing}; ${jarStr}` : jarStr;
        // remove duplicate casing
        delete safe["Cookie"];
      }

      // Body
      let bodyBuf = null;
      if (body != null) {
        bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        safe["content-length"] = bodyBuf.length;
      }

      const opts = {
        hostname:           parsed.hostname,
        port:               parsed.port || (isHttps ? 443 : 80),
        path:               parsed.pathname + parsed.search,
        method:             (method || "GET").toUpperCase(),
        headers:            safe,
        rejectUnauthorized: false,
        timeout:            30000,
      };

      const proxyReq = lib.request(opts, proxyRes => {
        // Absorb any new cookies from the response
        absorbSetCookie(proxyRes.headers);

        const chunks = [];
        proxyRes.on("data",  c  => chunks.push(c));
        proxyRes.on("end",   () => {
          const buf = Buffer.concat(chunks);
          const ct  = proxyRes.headers["content-type"] || "";

          const isText =
            ct.includes("text/")            ||
            ct.includes("application/json") ||
            ct.includes("application/xml")  ||
            ct.includes("ndjson")           ||
            ct.includes("javascript")       ||
            ct.includes("css")              ||
            ct.includes("svg");

          // Build clean response headers (strip content-encoding — we forced identity)
          const respHeaders = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            const kl = k.toLowerCase();
            if (kl === "content-encoding") continue; // was identity, browser doesn't need it
            if (kl === "set-cookie")       continue; // handled by cookie jar above
            respHeaders[k] = v;
          }

          resolve({
            status:   proxyRes.statusCode,
            headers:  respHeaders,
            body:     isText ? buf.toString("utf8") : buf.toString("base64"),
            encoding: isText ? "utf8" : "base64",
          });
        });
        proxyRes.on("error", reject);
      });

      proxyReq.on("error",   reject);
      proxyReq.on("timeout", () => { proxyReq.destroy(); reject(new Error("request timeout")); });
      if (bodyBuf) proxyReq.write(bodyBuf);
      proxyReq.end();
    });
  }

  /** Open and bridge the /api/host/stream WebSocket (WebRTC signaling). */
  function openStreamWs(wsUrl, protocols) {
    if (streamWs) { streamWs.close(); streamWs = null; }

    // Inject session cookies into the WS handshake
    const extraHeaders = {};
    const jar = jarString();
    if (jar) extraHeaders["cookie"] = jar;
    extraHeaders["origin"] = targetOrigin || "null";

    console.log(`[~] stream WS → ${wsUrl}`);
    const upstream = new WebSocket(wsUrl, protocols || [], {
      rejectUnauthorized: false,
      headers: extraHeaders,
    });

    upstream.on("open", () => {
      console.log(`[✓] stream WS open`);
      send({ type: "stream_ws_open" });
    });

    upstream.on("message", (data, isBinary) => {
      if (isBinary) {
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

  // ── Message router ────────────────────────────────────────────────────────
  clientWs.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { send({ type: "error", message: "invalid JSON" }); return; }

    switch (msg.type) {

      // ── CONNECT ───────────────────────────────────────────────────────────
      case "connect": {
        let tgt = (msg.url || "").replace(/\/+$/, "");
        if (!tgt) { send({ type: "error", message: "no url" }); return; }
        if (!tgt.startsWith("http")) tgt = "https://" + tgt;
        targetOrigin = tgt;
        console.log(`[>] target → ${targetOrigin}`);

        try {
          // Check whether we already have a valid session
          const authCheck = await proxyHttp(
            `${targetOrigin}/api/authenticate`, "GET",
            { accept: "*/*" }, null
          );

          // Fetch user info if authenticated
          let userInfo = null;
          if (authCheck.status === 200) {
            try {
              const ui = await proxyHttp(
                `${targetOrigin}/api/user`, "GET",
                { accept: "application/json" }, null
              );
              if (ui.status === 200) userInfo = JSON.parse(ui.body);
            } catch {}
          }

          send({
            type:            "connected",
            origin:          targetOrigin,
            authenticated:   authCheck.status === 200,
            userInfo,
          });
        } catch (err) {
          send({ type: "error", message: `cannot reach target: ${err.message}` });
          targetOrigin = null;
        }
        break;
      }

      // ── HTTP REQUEST ──────────────────────────────────────────────────────
      case "request": {
        const reqUrl = resolveUrl(msg.url);
        if (!reqUrl) { send({ type: "response", id: msg.id, error: "no url" }); return; }
        console.log(`[→] ${(msg.method||"GET").padEnd(6)} ${reqUrl.replace(targetOrigin||"","")}`);

        try {
          const r = await proxyHttp(reqUrl, msg.method, msg.headers, msg.body);
          send({ type: "response", id: msg.id,
            status: r.status, headers: r.headers, body: r.body, encoding: r.encoding });
        } catch (err) {
          send({ type: "response", id: msg.id, error: err.message });
        }
        break;
      }

      // ── STREAM WS ─────────────────────────────────────────────────────────
      case "stream_ws_open": {
        const wsUrl = resolveUrl(msg.url)
          .replace(/^https?:/, p => p.replace("http", "ws"));
        openStreamWs(wsUrl, msg.protocols);
        break;
      }

      case "stream_ws_send": {
        if (!streamWs || streamWs.readyState !== WebSocket.OPEN) {
          send({ type: "error", message: "stream WS not open" }); return;
        }
        if (msg.binary) {
          streamWs.send(Buffer.from(msg.data, "base64"), { binary: true });
        } else {
          streamWs.send(msg.data);
        }
        break;
      }

      case "stream_ws_close":
        if (streamWs) { streamWs.close(); streamWs = null; }
        break;

      case "ping":
        send({ type: "pong", ts: Date.now() });
        break;

      default:
        send({ type: "error", message: `unknown type: ${msg.type}` });
    }
  });

  clientWs.on("close", () => {
    console.log(`[-] client disconnected`);
    if (streamWs) { streamWs.close(); streamWs = null; }
  });

  clientWs.on("error", err => console.error(`[!] WS error: ${err.message}`));

  send({ type: "ready", version: "3.0.0" });
});

// ─── Start ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  moonlight-web-ws-proxy  v3.0                        ║
║                                                      ║
║  ws://localhost:${PORT}   (control channel)           ║
║  http://localhost:${PORT}  (health check)             ║
║                                                      ║
║  Fixes:                                              ║
║  ✓ Forces accept-encoding:identity (no zstd/br/gzip) ║
║  ✓ Cookie jar — captures + forwards mlSession        ║
║  ✓ Correct API endpoints from HAR                    ║
╚══════════════════════════════════════════════════════╝
`);
});