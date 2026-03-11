# moonlight-web-ws-proxy

A WebSocket proxy bridge that lets you use **moonlight-web-stream** from a
fully offline HTML file — no web server needed on the client side.

```
[client.html]  ←──── WebSocket ────→  [proxy-server.js]  ←── HTTPS ──→  [moon.holdheide.com]
  (offline)            (local)              (Node.js)                      (Sunshine / GFE)
```

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the proxy server

```bash
node proxy-server.js
# or with auto-reload:
npm run dev
```

You'll see:
```
╔══════════════════════════════════════════════╗
║   moonlight-web-ws-proxy  v1.0.0             ║
║   WebSocket: ws://localhost:8765             ║
║   Health:    http://localhost:8765           ║
╚══════════════════════════════════════════════╝
```

### 3. Open client.html

Open `client.html` directly in your browser (`file:///.../client.html`).
No local web server needed.

### 4. Connect

| Field       | Value                          |
|-------------|--------------------------------|
| Proxy WS    | `ws://localhost:8765`          |
| Target URL  | `moon.holdheide.com` (or your Sunshine host) |

Click **Connect**, then **Load Stream**.

---

## How it works

```
client.html
  │
  ├─ Opens a WebSocket to proxy-server.js
  ├─ Sends { type: "connect", url: "https://moon.holdheide.com" }
  │
  │  proxy-server.js:
  │  ├─ Fetches the moonlight web app HTML
  │  └─ Returns it + server info to client
  │
  ├─ Client injects the moonlight HTML into an <iframe>
  ├─ A script is injected into the iframe that overrides:
  │     • window.fetch
  │     • XMLHttpRequest
  │     • WebSocket
  │  All of these are tunneled through postMessage → parent → proxy WS
  │
  └─ The moonlight app runs normally, unaware it's proxied
```

## WebSocket Protocol

All messages are JSON.

### Client → Proxy

| type         | fields                              | description                    |
|--------------|-------------------------------------|--------------------------------|
| `connect`    | `url`                               | Set target, fetch server info  |
| `request`    | `id, url, method, headers, body`    | Proxy an HTTP request          |
| `ws_connect` | `url`                               | Open upstream WebSocket        |
| `ws_send`    | `data`                              | Send data on upstream WS       |
| `ws_close`   | —                                   | Close upstream WS              |
| `ping`       | —                                   | Latency check                  |

### Proxy → Client

| type          | fields                                      |
|---------------|---------------------------------------------|
| `ready`       | —                                           |
| `connected`   | `origin, rootStatus, serverInfo`            |
| `response`    | `id, status, headers, body, encoding`       |
| `ws_connected`| `url`                                       |
| `ws_message`  | `data`                                      |
| `ws_closed`   | `code, reason`                              |
| `pong`        | `ts`                                        |
| `error`       | `message`                                   |

## Configuration

Set `PORT` env variable to change the proxy port:
```bash
PORT=9000 node proxy-server.js
```

## Notes

- The proxy uses `rejectUnauthorized: false` so self-signed Sunshine certificates work.
- Binary responses (images, etc.) are base64-encoded over the WebSocket.
- WebRTC streams bypass the proxy — only signaling/HTTP traffic is proxied.
  The actual video/audio uses WebRTC peer connections directly.s