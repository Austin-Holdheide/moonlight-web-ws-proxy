/**
 * moonlight-web-ws-proxy  v4.0
 *
 * WHY v4:
 *   v3 loaded /stream.html into a blob URL <iframe>. This broke silently because
 *   the SPA spawns ~6 Web Workers with ES module imports:
 *     new Worker('./stream/pipeline/worker.js', {type:'module'})
 *   In a blob URL context, relative module imports resolve to blob:null/...
 *   which the browser refuses to load. The entire video/audio pipeline never
 *   starts — black screen.
 *
 * THE FIX:
 *   Make this server a FULL HTTP reverse proxy (not just WS).
 *   client.html points the iframe at:
 *     http://localhost:8765/stream.html?hostId=X&appId=Y
 *   All requests from the iframe (JS modules, Workers, API calls, WS) go
 *   through http://localhost:8765 which proxies them to the real server.
 *   Workers resolve imports as http://localhost:8765/stream/pipeline/...
 *   which works perfectly.
 *
 * ARCHITECTURE:
 *   HTTP  :8765  →  reverse proxy all requests to targetOrigin
 *   WS    :8765/proxy-control  →  control channel for client.html UI
 *   WS    :8765/api/host/stream  →  bridged to upstream WS (WebRTC signaling)
 *
 * SESSION / COOKIES:
 *   Login is done via the WS control channel (client.html is file://, can't
 *   do CORS HTTP directly). The proxy stores the mlSession in memory and
 *   injects it as a Cookie header into every outgoing HTTP request.
 *   The browser never needs to see the cookie.
 */

const http  = require("http");
const https = require("https");
const { WebSocketServer, WebSocket } = require("ws");
const url   = require("url");

const PORT           = process.env.PORT  || 8765;
const CONTROL_PATH   = "/proxy-control";   // WS path for client.html control channel

// ── Global proxy state (single-user tool) ──────────────────────────────────
let targetOrigin   = null;  // e.g. "https://moon.holdheide.com"
let sessionCookies = {};    // { mlSession: "abc123", ... }

function cookieHeader() {
  return Object.entries(sessionCookies).map(([k,v]) => `${k}=${v}`).join("; ");
}

function absorbSetCookie(rawHeaders) {
  // rawHeaders: Node http.IncomingMessage.headers["set-cookie"] — string | string[]
  const list = rawHeaders
    ? (Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders])
    : [];
  for (const line of list) {
    const pair = line.split(";")[0].trim();
    const eq   = pair.indexOf("=");
    if (eq === -1) continue;
    const name  = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) {
      sessionCookies[name] = value;
      console.log(`[🍪] cookie stored: ${name}`);
    }
  }
}

// ── Core HTTP proxy function ───────────────────────────────────────────────
function proxyHttp(reqUrl, method, reqHeaders, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(reqUrl); } catch(e) { return reject(e); }
    const isHttps = parsed.protocol === "https:";
    const lib     = isHttps ? https : http;

    const safe = {};
    for (const [k, v] of Object.entries(reqHeaders || {})) {
      const kl = k.toLowerCase();
      if (["host","connection","upgrade","proxy-connection",
           "transfer-encoding","keep-alive","te"].includes(kl)) continue;
      safe[k] = v;
    }
    safe["host"]            = parsed.host;
    safe["accept-encoding"] = "identity"; // no zstd/gzip/br — we can't decompress in proxy

    // Inject session cookie
    const jar = cookieHeader();
    if (jar) {
      const existing = (safe["cookie"] || "").replace(/^;\s*/,"");
      safe["cookie"] = existing ? `${existing}; ${jar}` : jar;
    }
    delete safe["Cookie"];

    let bodyBuf = null;
    if (body != null) {
      bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      safe["content-length"] = bodyBuf.length;
    }

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   (method || "GET").toUpperCase(),
      headers:  safe,
      rejectUnauthorized: false,
      timeout:  30000,
    };

    const proxyReq = lib.request(opts, proxyRes => {
      absorbSetCookie(proxyRes.headers["set-cookie"]);
      const chunks = [];
      proxyRes.on("data",  c  => chunks.push(c));
      proxyRes.on("end",   () => resolve({
        status:  proxyRes.statusCode,
        headers: proxyRes.headers,
        body:    Buffer.concat(chunks),
      }));
      proxyRes.on("error", reject);
    });
    proxyReq.on("error",   reject);
    proxyReq.on("timeout", () => { proxyReq.destroy(); reject(new Error("timeout")); });
    if (bodyBuf) proxyReq.write(bodyBuf);
    proxyReq.end();
  });
}

// ── HTTP server (health check only — all data goes through WS) ────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/proxy-health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "5.0.0", target: targetOrigin }));
    return;
  }

  res.writeHead(503, { "Content-Type": "text/plain" });
  res.end("All traffic goes through ws://localhost:" + PORT + CONTROL_PATH + "\n");
});

// ── WebSocket server (control channel only) ───────────────────────────────
const wss = new WebSocketServer({ noServer: true });

// WS control channel connections (from client.html)
const controlClients = new Set();

httpServer.on("upgrade", (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === CONTROL_PATH) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ── Control channel message handler ───────────────────────────────────────
wss.on("connection", (clientWs, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[+] control client  ${ip}`);
  controlClients.add(clientWs);

  let pingTimer  = null;
  let streamWs   = null;   // upstream /api/host/stream WebSocket

  function send(obj) {
    if (clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify(obj));
  }

  // ── Upstream stream WS ─────────────────────────────────────────────────
  function openStreamWs(wsUrl, protocols) {
    if (streamWs) { streamWs.close(); streamWs = null; }
    console.log(`[WS↑] → ${wsUrl}`);
    const jar = cookieHeader();
    const upstream = new WebSocket(wsUrl, protocols || [], {
      rejectUnauthorized: false,
      headers: { cookie: jar, origin: targetOrigin },
    });
    upstream.on("open", () => {
      console.log(`[WS↑] open`);
      send({ type: "stream_ws_open" });
    });
    upstream.on("message", (data, isBinary) => {
      send({
        type:   "stream_ws_message",
        data:   isBinary ? data.toString("base64") : data.toString("utf8"),
        binary: isBinary,
      });
    });
    upstream.on("close", (code, reason) => {
      console.log(`[WS↑] closed ${code}`);
      send({ type: "stream_ws_closed", code, reason: reason.toString() });
      streamWs = null;
    });
    upstream.on("error", err => {
      console.error(`[WS↑] error: ${err.message}`);
      send({ type: "stream_ws_error", message: err.message });
    });
    streamWs = upstream;
  }

  clientWs.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { send({ type:"error", message:"invalid JSON" }); return; }

    switch (msg.type) {

      // Set the target and probe it
      case "connect": {
        let tgt = (msg.url || "").replace(/\/+$/, "");
        if (!tgt) { send({ type:"error", message:"no url" }); return; }
        if (!tgt.startsWith("http")) tgt = "https://" + tgt;
        targetOrigin = tgt;
        console.log(`[>] target → ${targetOrigin}`);

        try {
          const auth = await proxyHttp(`${targetOrigin}/api/authenticate`, "GET",
                                       { accept: "*/*" }, null);
          let userInfo = null;
          if (auth.status === 200) {
            try {
              const ui = await proxyHttp(`${targetOrigin}/api/user`, "GET",
                                         { accept: "application/json" }, null);
              if (ui.status === 200) userInfo = JSON.parse(ui.body.toString("utf8"));
            } catch {}
          }
          send({ type:"connected", origin:targetOrigin,
                 authenticated: auth.status === 200, userInfo });
        } catch (err) {
          send({ type:"error", message:`cannot reach target: ${err.message}` });
          targetOrigin = null;
        }
        break;
      }

      // Proxy an HTTP request (UI + stream shim both use this)
      case "request": {
        const reqUrl = msg.url.startsWith("http") ? msg.url
          : targetOrigin + (msg.url.startsWith("/") ? msg.url : "/" + msg.url);
        console.log(`[→] ${(msg.method||"GET").padEnd(6)} ${reqUrl.replace(targetOrigin||"","")}`);
        try {
          const r = await proxyHttp(reqUrl, msg.method, msg.headers, msg.body);
          const ct  = r.headers["content-type"] || "";
          const isText = ct.includes("text/") || ct.includes("json") || ct.includes("xml")
                      || ct.includes("ndjson") || ct.includes("javascript") || ct.includes("svg");
          send({ type:"response", id:msg.id, status:r.status, headers:r.headers,
                 body: isText ? r.body.toString("utf8") : r.body.toString("base64"),
                 encoding: isText ? "utf8" : "base64" });
        } catch (err) {
          send({ type:"response", id:msg.id, error:err.message });
        }
        break;
      }

      // ── Stream WebSocket tunnel ────────────────────────────────────────
      case "stream_ws_open": {
        if (!targetOrigin) { send({ type:"error", message:"not connected" }); return; }
        const wsUrl = msg.url.startsWith("ws")
          ? msg.url
          : targetOrigin.replace(/^https?:/, p => p.replace("http","ws")) +
            (msg.url.startsWith("/") ? msg.url : "/" + msg.url);
        openStreamWs(wsUrl, msg.protocols);
        break;
      }

      case "stream_ws_send": {
        if (!streamWs || streamWs.readyState !== WebSocket.OPEN) return;
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
        send({ type:"pong", ts:Date.now() });
        break;

      default:
        send({ type:"error", message:`unknown: ${msg.type}` });
    }
  });

  clientWs.on("close", () => {
    console.log(`[-] control client disconnected`);
    controlClients.delete(clientWs);
    clearInterval(pingTimer);
    if (streamWs) { streamWs.close(); streamWs = null; }
  });

  clientWs.on("error", err => console.error(`[!] control WS error: ${err.message}`));

  send({ type:"ready", version:"5.0.0",
         controlUrl:`ws://localhost:${PORT}${CONTROL_PATH}` });
});

// ── Start ──────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║  moonlight-web-ws-proxy  v5.0  (WebSocket only)        ║
║                                                        ║
║  Control WS : ws://localhost:${PORT}${CONTROL_PATH}    ║
║  Health     : http://localhost:${PORT}/proxy-health    ║
║                                                        ║
║  All data (UI, stream assets, WS signaling)            ║
║  flows through the control WebSocket only.             ║
╚════════════════════════════════════════════════════════╝
`);
});