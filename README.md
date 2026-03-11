# moonlight-web-ws-proxy  v2

A WebSocket bridge that lets `client.html` (opened as a `file://` page)
talk to a remote **moonlight-web-stream** server.

---

## How moonlight-web-stream actually works

```
  Your Gaming PC
  ┌──────────────────────────────────────────┐
  │  Sunshine  (game capture / encoder)      │
  │  moonlight-web-stream  (Rust, port 8080) │
  │    ├─ serves SPA frontend at  GET /      │
  │    ├─ REST API at  /api/...              │
  │    └─ WebRTC signaling WS at             │
  │         /api/host/stream                 │
  └──────────────────────────────────────────┘
         ↑ HTTP + WS
  ┌──────────────────┐
  │  proxy-server.js │  (runs on your local network / same machine)
  │  Node.js         │
  └──────────────────┘
         ↑ WebSocket control channel (ws://localhost:8765)
  ┌──────────────────┐
  │  client.html     │  (opened from file://, no web server needed)
  │  offline browser │
  └──────────────────┘
```

The **actual video/audio** is WebRTC peer-to-peer — it does NOT go through
this proxy. Only the HTTP API calls and the WebRTC signaling WebSocket are
proxied.

---

## Quick start

```bash
# 1. Install the one dependency
npm install

# 2. Start the proxy
node proxy-server.js
#  → ws://localhost:8765

# 3. Open client.html in your browser (file:// is fine)

# 4. Fill in:
#    Proxy:             ws://localhost:8765
#    Moonlight Server:  https://moon.holdheide.com:8080
#    Click Connect
```

---

## What the proxy bridges

| Traffic | How |
|---|---|
| `GET /` — moonlight SPA HTML | HTTP request through proxy |
| `GET /api/user/info` — session check | HTTP request through proxy |
| `POST /api/user/login` — login | HTTP request through proxy |
| `GET /api/host` — list saved hosts | HTTP request through proxy |
| `POST /api/host` — add a host | HTTP request through proxy |
| `GET /api/host/:id/apps` — app list | HTTP request through proxy |
| `POST /api/host/:id/pair` — pairing | HTTP request through proxy |
| **`WS /api/host/stream`** — **WebRTC signaling** | **Full WS bridge** |
| WebRTC A/V data | **Direct peer-to-peer (not proxied)** |
| Static assets (JS/CSS/images) | HTTP request through proxy |

---

## Protocol (proxy ↔ client.html)

All messages are JSON over the WebSocket.

### client → proxy

| `type` | fields | description |
|---|---|---|
| `connect` | `url` | Set target origin, probe liveness |
| `request` | `id, url, method, headers, body` | Proxy HTTP call |
| `stream_ws_open` | `url, protocols?` | Open `/api/host/stream` WS |
| `stream_ws_send` | `data, binary` | Send frame upstream |
| `stream_ws_close` | — | Close upstream WS |
| `ping` | — | Latency check |

### proxy → client

| `type` | fields | description |
|---|---|---|
| `ready` | `version` | Proxy started |
| `connected` | `origin, rootStatus, userInfo` | Target reachable |
| `response` | `id, status, headers, body, encoding` | HTTP response |
| `stream_ws_open` | — | Upstream WS opened |
| `stream_ws_message` | `data, binary` | Frame from upstream |
| `stream_ws_closed` | `code, reason` | Upstream WS closed |
| `stream_ws_error` | `message` | Upstream WS error |
| `pong` | `ts` | Ping reply |
| `error` | `message` | Generic error |

---

## Configuration

```bash
PORT=9000 node proxy-server.js   # change proxy port
```

If your moonlight server uses a self-signed certificate (common with
Sunshine's built-in TLS) the proxy accepts it automatically
(`rejectUnauthorized: false`).

## Apache reverse proxy note

If you're already using Apache to reverse-proxy moonlight-web-stream,
you don't need this proxy at all — just open the Apache URL directly.
This proxy is only needed when accessing from an `file://` HTML page that
cannot make cross-origin requests.