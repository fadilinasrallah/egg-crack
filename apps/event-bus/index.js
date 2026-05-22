"use strict";

const http    = require("http");
const express = require("express");
const { WebSocketServer, OPEN } = require("ws");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const port   = Number(process.env.PORT || 4004);

app.use(express.json());

// ── Event store ───────────────────────────────────────
const MAX = 200;
let events = [];
let eventId = 1;

function storeEvent(type, payload, source = "http") {
  const ev = {
    id:      eventId++,
    ts:      new Date().toISOString(),
    type:    String(type || "event").slice(0, 80),
    payload: payload ?? null,
    source
  };
  events.push(ev);
  if (events.length > MAX) events = events.slice(-MAX);
  return ev;
}

// ── WebSocket ─────────────────────────────────────────
function broadcast(ev) {
  const msg = JSON.stringify({ kind: "event", event: ev });
  for (const ws of wss.clients) {
    if (ws.readyState === OPEN) ws.send(msg);
  }
}

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress || "unknown";
  console.log(`[event-bus] ws connected (${ip}) — ${wss.clients.size} total`);

  // Send welcome + recent history
  ws.send(JSON.stringify({
    kind:    "welcome",
    clients: wss.clients.size,
    recent:  events.slice(-20)
  }));

  // Clients can also publish events over WebSocket
  ws.on("message", raw => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type) {
        const ev = storeEvent(msg.type, msg.payload ?? null, "ws");
        broadcast(ev);
      }
    } catch { }
  });

  ws.on("close", () => {
    console.log(`[event-bus] ws disconnected — ${wss.clients.size} remaining`);
    broadcast(storeEvent("_client_left", { clients: wss.clients.size }, "system"));
  });

  broadcast(storeEvent("_client_joined", { clients: wss.clients.size }, "system"));
});

// Heartbeat every 30 s so clients don't time out
setInterval(() => {
  const ev = storeEvent("heartbeat", { clients: wss.clients.size, events: events.length }, "system");
  broadcast(ev);
}, 30_000).unref();

// ── HTTP API ──────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), clients: wss.clients.size });
});

app.get("/events", (req, res) => {
  const limit  = Math.min(Number(req.query.limit) || 50, MAX);
  const type   = req.query.type;
  const source = events.slice(-limit);
  res.json({
    total:  events.length,
    count:  source.length,
    events: type ? source.filter(e => e.type === type) : source
  });
});

app.post("/events", (req, res) => {
  const { type, payload } = req.body;
  if (!type) return res.status(400).json({ error: "type is required." });
  const ev = storeEvent(type, payload ?? null, "http");
  broadcast(ev);
  res.status(201).json(ev);
});

app.delete("/events", (_req, res) => {
  const count = events.length;
  events = [];
  const ev = storeEvent("_cleared", { removed: count }, "system");
  broadcast(ev);
  res.json({ ok: true, removed: count });
});

// ── Dashboard ─────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Event Bus</title>
  <style>
    :root { color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3;
           display: flex; flex-direction: column; min-height: 100vh; }

    header { padding: 12px 20px; background: #161b22; border-bottom: 1px solid #30363d;
             display: flex; align-items: center; gap: 14px; }
    .brand { font-weight: 700; color: #58a6ff; font-size: 15px; }
    #ws-dot { font-size: 16px; }
    #ws-label { font-size: 12px; color: #8b949e; }
    #client-count { font-size: 12px; color: #8b949e; margin-left: auto; }

    main { padding: 20px; max-width: 860px; margin: 0 auto; width: 100%; flex: 1; }

    .compose { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
    input { padding: 8px 12px; background: #0d1117; border: 1px solid #30363d;
            border-radius: 6px; color: #e6edf3; font: inherit; font-size: 13px; outline: none; }
    input:focus { border-color: #58a6ff; }
    #i-type { width: 160px; }
    #i-payload { flex: 1; min-width: 180px; }
    .btn { padding: 8px 16px; border-radius: 6px; font: inherit; font-size: 13px;
           font-weight: 600; cursor: pointer; border: 1px solid; transition: 0.12s; }
    .btn-emit  { background: #238636; border-color: #238636; color: #fff; }
    .btn-emit:hover { background: #2ea043; }
    .btn-clear { background: transparent; border-color: #30363d; color: #8b949e; }
    .btn-clear:hover { background: #21262d; color: #e6edf3; }

    #log { display: flex; flex-direction: column; gap: 6px; }

    .ev { background: #161b22; border: 1px solid #21262d; border-radius: 7px;
          padding: 10px 14px; animation: slide 0.18s ease; }
    .ev.system { border-color: #30363d; opacity: 0.7; }
    .ev-top { display: flex; align-items: baseline; gap: 10px; margin-bottom: 3px; }
    .ev-type { font-weight: 700; font-size: 13px; }
    .ev-type.system-type { color: #8b949e; }
    .ev-type.http-type   { color: #3fb950; }
    .ev-type.ws-type     { color: #58a6ff; }
    .ev-source { font-size: 10px; color: #484f58; text-transform: uppercase; letter-spacing: 0.05em; }
    .ev-ts  { font-size: 11px; color: #484f58; font-family: monospace; margin-left: auto; }
    .ev-payload { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px;
                  color: #8b949e; white-space: pre-wrap; word-break: break-all; }

    .empty { text-align: center; padding: 40px; color: #484f58; font-size: 13px; }

    @keyframes slide { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  </style>
</head>
<body>
  <header>
    <span class="brand">◈ Event Bus</span>
    <span id="ws-dot">○</span>
    <span id="ws-label">connecting…</span>
    <span id="client-count"></span>
  </header>
  <main>
    <div class="compose">
      <input id="i-type"    type="text" placeholder="event type" value="test.ping">
      <input id="i-payload" type="text" placeholder='payload — any JSON or plain text (optional)'>
      <button class="btn btn-emit"  id="btn-emit">Emit</button>
      <button class="btn btn-clear" id="btn-clear">Clear</button>
    </div>
    <div id="log"><div class="empty">Waiting for events…</div></div>
  </main>

  <script>
    const log      = document.getElementById("log");
    const wsDot    = document.getElementById("ws-dot");
    const wsLabel  = document.getElementById("ws-label");
    const ccEl     = document.getElementById("client-count");

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws;

    function connect() {
      ws = new WebSocket(proto + "//" + location.host);

      ws.onopen = () => {
        wsDot.textContent = "●"; wsDot.style.color = "#3fb950";
        wsLabel.textContent = "connected";
      };
      ws.onclose = () => {
        wsDot.textContent = "○"; wsDot.style.color = "#f85149";
        wsLabel.textContent = "disconnected — reconnecting…";
        setTimeout(connect, 3000);
      };
      ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.kind === "welcome") {
          ccEl.textContent = msg.clients + " connected";
          msg.recent.forEach(addEvent);
        } else if (msg.kind === "event") {
          addEvent(msg.event);
          if (msg.event.payload && msg.event.payload.clients !== undefined) {
            ccEl.textContent = msg.event.payload.clients + " connected";
          }
        }
      };
    }

    connect();

    function addEvent(ev) {
      const isEmpty = log.querySelector(".empty");
      if (isEmpty) isEmpty.remove();

      const el = document.createElement("div");
      const isSystem = ev.source === "system";
      el.className = "ev" + (isSystem ? " system" : "");

      let payloadStr = "";
      if (ev.payload !== null && ev.payload !== undefined) {
        payloadStr = typeof ev.payload === "object"
          ? JSON.stringify(ev.payload, null, 2) : String(ev.payload);
      }

      const typeClass = isSystem ? "system-type" : ev.source === "ws" ? "ws-type" : "http-type";
      el.innerHTML =
        '<div class="ev-top">' +
          '<span class="ev-type ' + typeClass + '">' + esc(ev.type) + '</span>' +
          '<span class="ev-source">' + esc(ev.source) + '</span>' +
          '<span class="ev-ts">'    + ev.ts + '</span>' +
        '</div>' +
        (payloadStr ? '<div class="ev-payload">' + esc(payloadStr) + '</div>' : '');

      log.prepend(el);
      while (log.children.length > 80) log.lastChild.remove();
    }

    document.getElementById("btn-emit").addEventListener("click", emit);
    document.getElementById("i-payload").addEventListener("keydown", e => { if (e.key === "Enter") emit(); });

    function emit() {
      const type    = document.getElementById("i-type").value.trim() || "event";
      const rawPay  = document.getElementById("i-payload").value.trim();
      let payload = rawPay || null;
      if (rawPay) { try { payload = JSON.parse(rawPay); } catch { } }
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type, payload }));
      } else {
        fetch("/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, payload })
        });
      }
    }

    document.getElementById("btn-clear").addEventListener("click", () => {
      fetch("/events", { method: "DELETE" });
      log.innerHTML = '<div class="empty">Waiting for events…</div>';
    });

    function esc(v) {
      return String(v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  </script>
</body>
</html>`);
});

server.listen(port, () => console.log(`[event-bus] http://0.0.0.0:${port}`));
