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

// ── HTTP server ────────────────────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
  // ── OPTIONS preflight (for file:// CORS if needed) ──────────────────────
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── Health check ────────────────────────────────────────────────────────
  if (req.url === "/proxy-health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "4.0.0", target: targetOrigin }));
    return;
  }

  // ── Must have a target set ───────────────────────────────────────────────
  if (!targetOrigin) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Proxy not configured — connect via the control WebSocket first");
    return;
  }

  // ── Collect request body ─────────────────────────────────────────────────
  const bodyChunks = [];
  req.on("data", c => bodyChunks.push(c));
  await new Promise(r => req.on("end", r));
  const bodyBuf = bodyChunks.length ? Buffer.concat(bodyChunks) : null;

  // ── Build target URL ─────────────────────────────────────────────────────
  const targetUrl = targetOrigin + req.url;
  console.log(`[HTTP] ${req.method.padEnd(6)} ${req.url}`);

  try {
    const r = await proxyHttp(targetUrl, req.method, req.headers, bodyBuf);

    // Build response headers — strip problematic ones, rewrite Set-Cookie
    const respHeaders = {};
    for (const [k, v] of Object.entries(r.headers)) {
      const kl = k.toLowerCase();
      if (kl === "content-encoding") continue; // we forced identity
      if (kl === "strict-transport-security") continue;
      if (kl === "set-cookie") {
        // Rewrite cookie: drop SameSite=Strict (would block cross-site) and
        // change domain to localhost so the browser accepts it
        const cookies = Array.isArray(v) ? v : [v];
        const rewritten = cookies.map(c =>
          c.replace(/;\s*SameSite=[^;]*/gi, "; SameSite=Lax")
           .replace(/;\s*Secure/gi, "")  // not https on localhost
           .replace(/;\s*Domain=[^;]*/gi, "")
        );
        respHeaders["set-cookie"] = rewritten;
        continue;
      }
      respHeaders[k] = v;
    }

    res.writeHead(r.status, respHeaders);
    res.end(r.body);
  } catch (err) {
    console.error(`[HTTP] proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy error: ${err.message}`);
    }
  }
});

// ── WebSocket server (handles both control channel + stream WS) ───────────
const wss = new WebSocketServer({ noServer: true });

// WS control channel connections (from client.html)
const controlClients = new Set();

httpServer.on("upgrade", (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === CONTROL_PATH) {
    // ── Control channel ──────────────────────────────────────────────────
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    // ── Upstream WS bridge (e.g. /api/host/stream) ──────────────────────
    if (!targetOrigin) {
      socket.destroy();
      return;
    }
    const wsUrl = targetOrigin.replace(/^https?:/, p => p.replace("http","ws")) + req.url;
    console.log(`[WS↑] bridging → ${wsUrl}`);

    const jar = cookieHeader();
    const upstream = new WebSocket(wsUrl, [], {
      rejectUnauthorized: false,
      headers: {
        "cookie": jar,
        "origin": targetOrigin,
      },
    });

    upstream.on("open", () => {
      console.log(`[WS↑] open`);
      // Complete the upgrade on the client side
      wss.handleUpgrade(req, socket, head, clientWs => {
        // Pipe both directions
        clientWs.on("message", (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN)
            upstream.send(data, { binary: isBinary });
        });
        upstream.on("message", (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN)
            clientWs.send(data, { binary: isBinary });
        });
        clientWs.on("close", () => upstream.close());
        upstream.on("close", () => clientWs.close());
        clientWs.on("error", () => upstream.close());
        upstream.on("error", err => {
          console.error(`[WS↑] upstream error: ${err.message}`);
          clientWs.close();
        });
      });
    });

    upstream.on("error", err => {
      console.error(`[WS↑] connect error: ${err.message}`);
      socket.destroy();
    });
  }
});

// ── Control channel message handler ───────────────────────────────────────
wss.on("connection", (clientWs, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[+] control client  ${ip}`);
  controlClients.add(clientWs);

  let pingTimer = null;
  let pingTs    = 0;

  function send(obj) {
    if (clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify(obj));
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

      // Proxy an HTTP request (used by client.html UI, not the stream iframe)
      case "request": {
        const reqUrl = msg.url.startsWith("http") ? msg.url
          : targetOrigin + (msg.url.startsWith("/") ? msg.url : "/" + msg.url);
        console.log(`[→ ctrl] ${(msg.method||"GET").padEnd(6)} ${reqUrl.replace(targetOrigin||"","")}`);
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
  });

  clientWs.on("error", err => console.error(`[!] control WS error: ${err.message}`));

  send({ type:"ready", version:"4.0.0",
         proxyUrl:`http://localhost:${PORT}`,
         controlUrl:`ws://localhost:${PORT}${CONTROL_PATH}` });
});

// ── Start ──────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  moonlight-web-ws-proxy  v4.0                        ║
║                                                      ║
║  HTTP reverse proxy : http://localhost:${PORT}         ║
║  Control WS         : ws://localhost:${PORT}/proxy-control ║
║  Health             : http://localhost:${PORT}/proxy-health║
║                                                      ║
║  v4 fix: full HTTP proxy — Web Workers resolve       ║
║  imports correctly (no more blob URL iframe)         ║
╚══════════════════════════════════════════════════════╝
`);
});