# moonlight-web-ws-proxy

A local HTTP + WebSocket reverse proxy that lets you use [moonlight-web-stream](https://github.com/feldkamp-dev/moonlight-web-stream) from an offline `file://` HTML page.

## Why this exists

Browsers block `file://` pages from making requests to external HTTPS servers (CORS). This proxy runs locally and bridges your browser to a remote moonlight-web-stream server, handling auth cookies, compression, and WebSocket signaling transparently.

## How it works

```
client.html (file://)
  │
  └─ WebSocket ──► proxy-server.js :8765
                        │
                        ├─ HTTP reverse proxy ──► moon.yourserver.com (all assets, API)
                        └─ WS bridge ──────────► /api/host/stream (WebRTC signaling)

Stream iframe
  └─ src="http://localhost:8765/stream.html?hostId=X&appId=Y"
       │
       └─ All requests (JS modules, Workers, API, WS) ──► proxy ──► server
```

The stream iframe is pointed at `http://localhost:8765` rather than a blob URL. This is critical — moonlight-web-stream spawns Web Workers with ES module imports. In a blob URL context those imports resolve to `blob:null/...` and silently fail. With a real HTTP origin they work correctly.

## Requirements

- Node.js 18+
- `npm install` (installs the `ws` package only)
- A running moonlight-web-stream server (e.g. at `moon.yourserver.com`)

## Setup

```bash
npm install
node proxy-server.js
```

Then open `client.html` in your browser (double-click it, or drag it to the address bar).

## Usage

1. **Control WS** — leave as `ws://localhost:8765/proxy-control`
2. **Server** — enter your moonlight-web-stream URL, e.g. `moon.holdheide.com`
3. Click **Connect**
4. Log in when prompted (credentials go directly to your server, not stored locally)
5. Select a host → select an app → stream loads

## API surface

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/authenticate` | Check session — 200 ok, 401 need login |
| `POST` | `/api/login` | Body: `{"name":"…","password":"…"}` → sets `mlSession` cookie |
| `GET` | `/api/user` | Current user info |
| `GET` | `/api/hosts` | Host list (ndjson streaming) |
| `GET` | `/api/host?host_id=X` | Single host details |
| `GET` | `/api/apps?host_id=X` | App list for a host |
| `GET` | `/api/app/image?host_id=X&app_id=Y&force_refresh=false` | App thumbnail (binary) |
| `GET` | `/stream.html?hostId=X&appId=Y` | Stream page (loaded in iframe) |
| `WS` | `/api/host/stream` | WebRTC signaling (auto-bridged by proxy) |

## Proxy endpoints

| Endpoint | Description |
|----------|-------------|
| `http://localhost:8765/*` | HTTP reverse proxy — all requests forwarded to target |
| `ws://localhost:8765/proxy-control` | Control channel for client.html UI |
| `ws://localhost:8765/api/host/stream` | Auto-bridged to upstream WS |
| `http://localhost:8765/proxy-health` | Health check / status JSON |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8765` | Port to listen on |

## File structure

```
proxy-server.js   — Node.js reverse proxy (one dependency: ws)
client.html       — Offline UI (works from file://)
package.json      — { "dependencies": { "ws": "^8.18.0" } }
README.md         — This file
```

## Debugging

The proxy logs every HTTP request and WebSocket event to stdout:

```
[HTTP] GET    /stream.html
[HTTP] GET    /stream.js
[WS↑] bridging → wss://moon.yourserver.com/api/host/stream
[WS↑] open
[🍪] cookie stored: mlSession
```

If the stream iframe shows a black screen with no console errors, check that the proxy stdout shows the Worker script requests (`/stream/pipeline/worker.js`) — these should appear 6 times as the pipeline initializes.

## Version history

**v1** — Initial attempt. Wrong architecture: assumed moonlight-web-stream was a Sunshine proxy layer.

**v2** — Corrected API surface after reading the actual repo. iframe shim injected into fetched HTML.

**v3** — Fixed zstd compression (all responses were binary garbage). Fixed cookie jar (mlSession not forwarded). Fixed login field name (`name` not `username`).

**v4** — Fixed black screen. Root cause: blob URL iframe breaks Web Worker ES module imports. Solution: full HTTP reverse proxy, iframe pointed at `http://localhost:8765/stream.html` directly. No fetch/XHR/WebSocket shim needed.