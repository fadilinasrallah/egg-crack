"use strict";

require("dotenv").config();

const crypto = require("crypto");
const fs     = require("fs");
const http   = require("http");
const path   = require("path");

const express            = require("express");
const { WebSocketServer } = require("ws");

const { Pm2Manager }       = require("./pm2");
const { CloudflareManager } = require("./cloudflare");
const { PtyManager }        = require("./pty-manager");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT      = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const ROOT      = process.cwd();
const APPS_DIR  = path.resolve(ROOT, process.env.APPS_DIR  || "apps");
const DATA_DIR  = path.resolve(ROOT, process.env.DATA_DIR  || "data");
const PM2_HOME  = path.resolve(ROOT, process.env.PM2_HOME  || path.join("data", ".pm2"));
const AUTH_USER = (process.env.DASHBOARD_USERNAME || "").trim();
const AUTH_PASS = (process.env.DASHBOARD_PASSWORD || "").trim();
const CF_ONLY   = process.env.CF_ONLY === "1";

// ── Cloudflare IP ranges (https://www.cloudflare.com/ips/) ───────────────────
const CF_CIDRS = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15",  "104.16.0.0/13",
  "104.24.0.0/14",   "172.64.0.0/13",   "131.0.72.0/22"
];

function _ipToInt(ip) {
  return ip.split(".").reduce((n, o) => (n << 8) | Number(o), 0) >>> 0;
}
function _inCidr(ip, cidr) {
  const [base, bits] = cidr.split("/");
  const mask = bits === "32" ? 0xffffffff : ~((1 << (32 - +bits)) - 1) >>> 0;
  return (_ipToInt(ip) & mask) >>> 0 === (_ipToInt(base) & mask) >>> 0;
}
function isCloudflareTrusted(rawIp) {
  // localhost = cloudflared tunnel proxy running in the same container
  if (!rawIp) return false;
  const ip = rawIp.startsWith("::ffff:") ? rawIp.slice(7) : rawIp;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  return CF_CIDRS.some(cidr => _inCidr(ip, cidr));
}

// One-time token used to authenticate WebSocket terminal connections.
const TERM_TOKEN = crypto.randomBytes(20).toString("hex");

// Startup / diagnostic event ring buffer (max 200 entries).
const startupLog = [];
function slog(level, msg) {
  const s = String(msg);
  startupLog.push({ ts: new Date().toISOString(), level, msg: s });
  if (startupLog.length > 200) startupLog.shift();
  const tag = `[wispnodes:${level}]`;
  if (level === "error") console.error(tag, s);
  else if (level === "warn")  console.warn(tag,  s);
  else console.log(tag, s);
}

for (const d of [APPS_DIR, DATA_DIR, path.join(DATA_DIR, "logs"), path.join(DATA_DIR, "bin"), PM2_HOME]) {
  fs.mkdirSync(d, { recursive: true });
}

// ── Try loading node-pty (native module, may not be compiled yet) ─────────────
let pty = null;
try {
  pty = require("node-pty");
  slog("info", "node-pty loaded — terminal enabled");
} catch (e) {
  slog("warn", `node-pty unavailable: ${e.message} — run npm install`);
  console.warn("[terminal] node-pty unavailable — terminal feature disabled. Run: npm install");
}

// ── Managers ──────────────────────────────────────────────────────────────────
const pm2 = new Pm2Manager({
  root:        ROOT,
  appsDir:     APPS_DIR,
  pm2Home:     PM2_HOME,
  logsDir:     path.join(PM2_HOME, "logs"),
  useUserland: process.env.PM2_USE_USERLAND === "1",
  userlandDir: process.env.USERLAND_DIR || "/home/container/.userland"
});

const cf = new CloudflareManager({
  binDir:      path.join(DATA_DIR, "bin"),
  logsDir:     path.join(DATA_DIR, "logs"),
  token:       process.env.CF_TUNNEL_TOKEN || "",
  autoRestart: process.env.CF_TUNNEL_AUTO_START !== "0",
  onLog:       msg => String(msg).split(/\r?\n/).filter(Boolean).forEach(l => slog("cf", l))
});

const ptym = new PtyManager({
  root:    ROOT,
  logsDir: path.join(DATA_DIR, "logs"),
});

const configFile = path.join(DATA_DIR, "config.json");
let config = readConfig();

// ── Harden environment ────────────────────────────────────────────────────────
// Strip everything from process.env that managed apps should not inherit.
// All sensitive values (DASHBOARD_PASSWORD, CF_TUNNEL_TOKEN, Pterodactyl vars,
// etc.) have already been read into JS constants above. Removing them here
// ensures no child process — regardless of how it is launched — can ever see
// them. PM2_HOME is kept temporarily; _connect() removes it after PM2 connects.
(function _hardenEnv() {
  const KEEP = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL",
    "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ",
    "TERM", "NODE_ENV", "NODE_PATH", "NODE_VERSION",
    "npm_config_cache", "npm_config_prefix",
    "TMPDIR", "TEMP", "TMP",
    "XDG_RUNTIME_DIR",
    "PM2_HOME",  // removed from process.env after PM2 connects
  ]);
  for (const k of Object.keys(process.env)) {
    if (!KEEP.has(k)) delete process.env[k];
  }
})();

// ── Express app ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cfOnly);
app.use(auth);
app.use(express.static(path.join(__dirname, "..", "public")));

// ── SSE — real-time state stream ──────────────────────────────────────────────
const sseClients  = new Set();
const _installing = new Set(); // names of apps currently running npm install
let broadcasting  = false;
let syncing       = false;
let cachedState   = null;

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const client = { res };
  sseClients.add(client);
  // Send cached state immediately if available, then fetch fresh.
  if (cachedState) sseSend(client, "state", cachedState);
  getState().then(s => { cachedState = s; sseSend(client, "state", s); }).catch(() => {});

  const hb = setInterval(() => { try { res.write(": h\n\n"); } catch { clearInterval(hb); } }, 15000);
  req.on("close", () => { sseClients.delete(client); clearInterval(hb); });
});

function sseSend(client, event, data) {
  try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { }
}

async function broadcast() {
  if (broadcasting || !sseClients.size) return;
  broadcasting = true;
  try {
    const state = await getState();
    cachedState = state;
    for (const c of sseClients) sseSend(c, "state", state);
  } catch { } finally { broadcasting = false; }
}

// ── Terminal token ────────────────────────────────────────────────────────────
app.get("/api/terminal-token", (_req, res) => {
  res.json({ token: TERM_TOKEN, enabled: Boolean(pty) });
});

// ── Health / diagnostics ──────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  let pm2Procs = [], pm2Ok = false;
  try { pm2Procs = await pm2.list(); pm2Ok = true; } catch (e) {
    slog("error", `pm2 list failed: ${e.message}`);
  }
  res.json({
    node:      process.version,
    platform:  process.platform,
    arch:      process.arch,
    uptime:    Math.floor(process.uptime()),
    terminal:  { enabled: Boolean(pty) },
    cloudflare: cf.status(),
    pm2:       { ok: pm2Ok, processes: pm2Procs.length },
    apps:      { count: pm2.discover().length },
    config:    {
      port:    PORT,
      appsDir: path.relative(ROOT, APPS_DIR) || ".",
      dataDir: path.relative(ROOT, DATA_DIR) || ".",
      auth:    Boolean(AUTH_USER && AUTH_PASS)
    },
    startupLog: startupLog.slice(-100)
  });
});

// ── Process API ───────────────────────────────────────────────────────────────
app.post("/api/processes/:name/start", async (req, res) => {
  try {
    const name        = req.params.name;
    const saved       = config.processes[name] || {};
    const interactive = Boolean(req.body.interactive ?? saved.interactive ?? false);
    const def         = {
      name,
      cwd:         str(req.body.cwd     || saved.cwd     || path.join("apps", name)),
      command:     str(req.body.command || saved.command),
      port:        str(req.body.port    || saved.port),
      env:         merge(saved.env, req.body.env),
      interactive,
    };
    config.processes[name] = { ...def, enabled: true };
    writeConfig();

    // Cross-manager cleanup: tear down the OTHER manager's copy of this process
    // before starting, so there's no port conflict or duplicate entry.
    if (interactive) {
      try { await pm2.remove(name); } catch { }
    } else {
      ptym.remove(name);
    }

    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);

    if (interactive) {
      // PTY processes: truncate the log first (clears stale crash cycles from
      // the previous session) then write the STARTING banner and run auto-install.
      // The PTY's scrollback is rebuilt from this file, so it will only show the
      // current session's output.
      const ptymLogsDir = path.join(DATA_DIR, "logs");
      const ptymLog     = path.join(ptymLogsDir, `${name}-out.log`);
      try {
        fs.mkdirSync(ptymLogsDir, { recursive: true });
        fs.writeFileSync(ptymLog, "");  // fresh log for each explicit start
        fs.appendFileSync(ptymLog, `\r\n\x1b[36;1m◆ STARTING ${name} [${ts}]\x1b[0m\r\n`);
      } catch { }
      const cwd = path.resolve(ROOT, def.cwd || path.join("apps", name));
      _installing.add(name);
      try {
        await pm2._autoInstall(cwd, ptymLog);
      } finally {
        _installing.delete(name);
      }
    } else {
      // PM2 processes: write banner to PM2 log dir before _autoInstall runs.
      const logsDir = path.join(PM2_HOME, "logs");
      const outLog  = path.join(logsDir, `${name}-out.log`);
      try {
        fs.mkdirSync(logsDir, { recursive: true });
        fs.appendFileSync(outLog, `\r\n\x1b[36;1m◆ STARTING ${name} [${ts}]\x1b[0m\r\n`);
      } catch { }
    }

    const info = interactive ? ptym.start(def) : await pm2.start(def);
    broadcast();
    res.json(info);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/processes/:name/restart", async (req, res) => {
  try {
    const { name } = req.params;
    if (config.processes[name]) { config.processes[name].enabled = true; writeConfig(); }
    const interactive = Boolean(config.processes[name]?.interactive);
    const info = interactive ? ptym.restart(name) : await pm2.restart(name);
    broadcast();
    res.json(info);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/processes/:name/stop", async (req, res) => {
  try {
    const { name } = req.params;
    if (config.processes[name]) { config.processes[name].enabled = false; writeConfig(); }
    const interactive = Boolean(config.processes[name]?.interactive);
    const info = interactive ? ptym.stop(name) : await pm2.stop(name);
    broadcast();
    res.json(info);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete("/api/processes/:name", async (req, res) => {
  try {
    const { name } = req.params;
    delete config.processes[name];
    writeConfig();
    // Always clean up both managers to prevent stale duplicates.
    ptym.remove(name);
    try { await pm2.remove(name); } catch { }
    broadcast();
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get("/api/processes/:name/logs", async (req, res) => {
  try {
    const { name } = req.params;
    const lines       = Math.min(Number(req.query.lines) || 150, 500);
    const interactive = Boolean(config.processes[name]?.interactive);
    res.json(interactive ? ptym.logs(name, lines) : await pm2.logs(name, lines));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Cloudflare API ────────────────────────────────────────────────────────────
// ── WebSocket servers ─────────────────────────────────────────────────────────
const termWss      = new WebSocketServer({ noServer: true }); // free shell sessions
const attachWss    = new WebSocketServer({ noServer: true }); // live PTY attach (interactive procs)
const logstreamWss = new WebSocketServer({ noServer: true }); // live log tail (PM2 procs)

server.on("upgrade", (req, socket, head) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { socket.destroy(); return; }

  // Validate auth token for any WebSocket endpoint.
  if (AUTH_USER && AUTH_PASS && url.searchParams.get("token") !== TERM_TOKEN) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  if (url.pathname === "/api/terminal") {
    termWss.handleUpgrade(req, socket, head, ws => termWss.emit("connection", ws, req));
  } else if (url.pathname === "/api/attach") {
    attachWss.handleUpgrade(req, socket, head, ws => attachWss.emit("connection", ws, req));
  } else if (url.pathname === "/api/logstream") {
    logstreamWss.handleUpgrade(req, socket, head, ws => logstreamWss.emit("connection", ws, req));
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

termWss.on("connection", (ws, req) => {
  if (!pty) {
    ws.send(JSON.stringify({ t: "error", msg: "node-pty is not installed. Run: npm install" }));
    ws.close();
    return;
  }

  let url;
  try { url = new URL(req.url, "http://x"); } catch { ws.close(); return; }

  const cwd   = safeCwd(url.searchParams.get("cwd") || ".");
  const shell = getShell();

  let proc;
  try {
    proc = pty.spawn(shell, [], {
      name:  "xterm-256color",
      cols:  80,
      rows:  24,
      cwd,
      env:   { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
    });
  } catch (err) {
    ws.send(JSON.stringify({ t: "error", msg: err.message }));
    ws.close();
    return;
  }

  console.log(`[terminal] open  shell=${shell}  cwd=${path.relative(ROOT, cwd) || "."}`);

  // PTY → browser: send raw bytes (binary WS frame).
  proc.onData(data => {
    if (ws.readyState === 1) ws.send(Buffer.from(data), { binary: true });
  });

  proc.onExit(({ exitCode }) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: "exit", code: exitCode }));
    ws.close();
  });

  // Browser → PTY: JSON control messages.
  ws.on("message", raw => {
    const str = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    try {
      const msg = JSON.parse(str);
      if (msg.t === "i" && typeof msg.d === "string") {
        proc.write(msg.d);
      } else if (msg.t === "resize") {
        const cols = Math.max(1, Math.min(Number(msg.cols) || 80, 500));
        const rows = Math.max(1, Math.min(Number(msg.rows) || 24, 200));
        proc.resize(cols, rows);
      }
    } catch { }
  });

  ws.on("close", () => {
    console.log(`[terminal] close cwd=${path.relative(ROOT, cwd) || "."}`);
    try { proc.kill(); } catch { }
  });

  ws.on("error", () => { try { proc.kill(); } catch { } });
});

// ── Attach — live PTY session on a managed interactive process ────────────────
attachWss.on("connection", (ws, req) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { ws.close(); return; }
  const name = (url.searchParams.get("name") || "").trim();
  if (!name) {
    ws.send(JSON.stringify({ t: "error", msg: "name parameter is required" }));
    ws.close();
    return;
  }
  try {
    ptym.attach(name, ws);
  } catch (err) {
    ws.send(JSON.stringify({ t: "error", msg: err.message }));
    ws.close();
  }
});

// ── Log stream — live tail of PM2 stdout + stderr log files ──────────────────
// Uses deterministic paths so it works even before the process has been
// registered with PM2 (e.g. while _autoInstall is running npm install).
logstreamWss.on("connection", (ws, req) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { ws.close(); return; }
  const name = (url.searchParams.get("name") || "").trim();
  if (!name) { ws.close(); return; }

  const logsDir = path.join(PM2_HOME, "logs");
  const outLog  = path.join(logsDir, `${name}-out.log`);
  const errLog  = path.join(logsDir, `${name}-err.log`);

  // Send the tail of the existing stdout log as initial scrollback.
  // stderr is polled separately and appended live.
  try {
    const raw  = fs.readFileSync(outLog, "utf8");
    const tail = raw.split("\n").slice(-200).join("\n");
    if (tail && ws.readyState === 1) ws.send(Buffer.from(tail + "\n"), { binary: true });
  } catch { }

  // Track current read offsets for each file independently.
  let outOffset = 0;
  let errOffset = 0;
  try { outOffset = fs.statSync(outLog).size; } catch { }
  try { errOffset = fs.statSync(errLog).size; } catch { }

  function pollOne(logFile, offsetRef) {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > offsetRef.value) {
        const len = stat.size - offsetRef.value;
        const buf = Buffer.alloc(len);
        const fd  = fs.openSync(logFile, "r");
        fs.readSync(fd, buf, 0, len, offsetRef.value);
        fs.closeSync(fd);
        offsetRef.value = stat.size;
        if (ws.readyState === 1) ws.send(buf, { binary: true });
      } else if (stat.size < offsetRef.value) {
        offsetRef.value = stat.size; // truncated / rotated
      }
    } catch { }
  }

  const outRef = { value: outOffset };
  const errRef = { value: errOffset };

  const timer = setInterval(() => {
    if (ws.readyState !== 1) { clearInterval(timer); return; }
    pollOne(outLog, outRef);
    pollOne(errLog, errRef);
  }, 300);

  ws.on("close", () => clearInterval(timer));
  ws.on("error", () => clearInterval(timer));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`[wispnodes] http://0.0.0.0:${PORT}`);
  console.log(`[wispnodes] apps     ${APPS_DIR}`);
  console.log(`[wispnodes] data     ${DATA_DIR}`);
  console.log(`[wispnodes] auth     ${AUTH_USER && AUTH_PASS ? "enabled" : "disabled"}`);
  console.log(`[wispnodes] tunnel   ${cf.status().configured ? "configured" : "not configured"}`);
  console.log(`[wispnodes] terminal ${pty ? "enabled" : "disabled (npm install needed)"}`);

  slog("info", `Server started on port ${PORT} (${process.platform}/${process.arch} ${process.version})`);
  slog("info", `Auth: ${AUTH_USER && AUTH_PASS ? "enabled" : "disabled"}`);
  slog("info", `Apps dir: ${path.relative(ROOT, APPS_DIR) || "."}`);

  if (cf.status().configured) {
    slog("info", "CF_TUNNEL_TOKEN set — attempting to start cloudflared");
    cf.start().catch(err => {
      slog("error", `cf start failed: ${err.message}`);
      console.error("[cf]", err.message);
    });
  } else {
    slog("info", "CF_TUNNEL_TOKEN not set — tunnel disabled");
  }

  await syncApps().catch(err => console.error("[sync]", err.message));

  // First summary at 8 s (shows download-in-progress state if binary is being fetched).
  setTimeout(() => printHealthSummary().catch(() => {}), 8_000).unref();
  // Second summary at 90 s — cloudflared download + first connect should have resolved by then.
  setTimeout(() => printHealthSummary().catch(() => {}), 90_000).unref();

  setInterval(() => syncApps().catch(err => console.error("[sync]", err.message)), 15000).unref();
  setInterval(() => broadcast(), 4000).unref();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function printHealthSummary() {
  let pm2Procs = [], pm2Ok = false;
  try { pm2Procs = await pm2.list(); pm2Ok = true; } catch {}
  const cfSt = cf.status();
  const cfLine = cfSt.downloading
    ? "⧗ downloading cloudflared binary… (will connect after download)"
    : cfSt.running
      ? (cfSt.external ? "✓ running (external)" : "✓ running (managed)")
      : cfSt.configured
        ? "✗ configured but NOT connecting — see [wispnodes:cf] lines above"
        : "– not configured (set CF_TUNNEL_TOKEN)";
  const sep = "─".repeat(50);
  [
    sep,
    "  Container Setup Health",
    `  Runtime:   ${process.version} · ${process.platform}/${process.arch}`,
    `  Terminal:  ${pty ? "✓ node-pty enabled" : "✗ disabled — run: npm install"}`,
    `  PM2:       ${pm2Ok ? `✓ connected · ${pm2Procs.length} process(es) running` : "✗ unavailable"}`,
    `  Auth:      ${AUTH_USER && AUTH_PASS ? "✓ enabled" : "✗ no credentials set"}`,
    `  Tunnel:    ${cfLine}`,
    `  Apps dir:  ${path.relative(ROOT, APPS_DIR) || "."} (${pm2.discover().length} discovered)`,
    `  Data dir:  ${path.relative(ROOT, DATA_DIR) || "."}`,
    sep
  ].forEach(l => console.log("[wispnodes]", l));
}

// ── PM2 lifecycle event tracking ──────────────────────────────────────────────
// Detect state transitions in PM2-managed processes and write ANSI event lines
// to their log files, mirroring the PtyManager event style.
const _prevPm2States = new Map();

function _pm2EventLine(type, detail = "") {
  const EVT_COLORS = { STARTED: 32, STOPPED: 33, CRASHED: 31, RESTARTING: 36, MAX_RESTARTS: 31 };
  const ts  = new Date().toISOString().replace("T", " ").slice(0, 19);
  const col = EVT_COLORS[type] || 37;
  return (
    `\r\n\x1b[${col};1m◆ ${type}\x1b[0m` +
    `\x1b[${col}m${detail ? ` — ${detail}` : ""} [${ts}]\x1b[0m\r\n`
  );
}

function _trackPm2Events(procs) {
  for (const p of procs) {
    const prev = _prevPm2States.get(p.name);
    const curr = p.status;
    let type = null, detail = "";

    if (prev === undefined) {
      // First time we see this process after a server (re)start.
      // If it's already online, emit STARTED so the logstream isn't silent.
      if (curr === "online") {
        type   = "STARTED";
        detail = p.pid ? `pid=${p.pid}` : "";
      }
    } else if (prev !== curr) {
      if (curr === "online") {
        type   = "STARTED";
        detail = p.pid ? `pid=${p.pid}` : "";
      } else if (curr === "stopped" && prev === "online") {
        type = "STOPPED";
      } else if (curr === "errored") {
        type   = "CRASHED";
        detail = `restarts=${p.restarts}`;
      }
    }

    if (type && p.outLog) {
      try { fs.appendFileSync(p.outLog, _pm2EventLine(type, detail)); } catch { }
    }
    _prevPm2States.set(p.name, curr);
  }
}

let _syncReady = false; // true after first successful non-empty PM2 list

async function syncApps() {
  if (syncing) return;
  syncing = true;
  try {
    // If PM2 throws (stream error etc.), skip this tick entirely.
    const procs = await pm2.list().catch(() => null);
    if (!procs) return;

    // Count only non-interactive enabled processes — interactive ones are managed by ptym.
    const enabledPm2Count = Object.values(config.processes)
      .filter(d => d.enabled && !d.interactive).length;
    if (_syncReady && procs.length === 0 && enabledPm2Count > 0) return;
    if (procs.length > 0) _syncReady = true;

    const byName = new Map(procs.map(p => [p.name, p]));
    for (const [name, def] of Object.entries(config.processes)) {
      if (!def.enabled) continue;
      if (def.interactive) {
        // Interactive processes are owned by PtyManager — start if absent.
        // Skip if npm install is currently running for this app (race guard).
        if (!ptym.has(name) && !_installing.has(name)) {
          slog("info", `auto-starting interactive "${name}"…`);
          try { ptym.start(def); } catch (err) { slog("error", `auto-start "${name}" failed: ${err.message}`); }
        }
      } else if (!byName.has(name)) {
        // Non-interactive: only start if completely absent from PM2.
        slog("info", `auto-starting "${name}"…`);
        await pm2.start(def).catch(err => slog("error", `auto-start "${name}" failed: ${err.message}`));
      }
    }
  } finally { syncing = false; }
}

let _prevNet = null;
function readNetStats() {
  if (process.platform !== "linux") return null;
  try {
    const lines = fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2);
    let rx = 0, tx = 0;
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 10) continue;
      const iface = p[0].replace(/:$/, "");
      if (iface === "lo") continue;
      rx += Number(p[1]);
      tx += Number(p[9]);
    }
    const now = Date.now();
    let rxRate = 0, txRate = 0;
    if (_prevNet) {
      const dt = (now - _prevNet.ts) / 1000;
      if (dt > 0) { rxRate = Math.max(0, (rx - _prevNet.rx) / dt); txRate = Math.max(0, (tx - _prevNet.tx) / dt); }
    }
    _prevNet = { rx, tx, ts: now };
    return { rxRate, txRate };
  } catch { return null; }
}

async function getState() {
  const [pm2Procs, discovered] = await Promise.all([
    pm2.list().catch(() => []),
    Promise.resolve(pm2.discover()),
  ]);
  _trackPm2Events(pm2Procs);
  const ptyProcs     = ptym.list();
  // PTY processes take precedence: hide any PM2 entry with the same name.
  const ptyNames     = new Set(ptyProcs.map(p => p.name));
  const filteredPm2  = pm2Procs.filter(p => !ptyNames.has(p.name));
  const procs        = [...filteredPm2, ...ptyProcs];
  const running      = new Set(procs.map(p => p.name));
  const runningPty   = new Set(ptyProcs.map(p => p.name));
  return {
    processes: procs,
    discovered: discovered.map(d => ({
      ...d,
      enabled:          Boolean(config.processes[d.name]?.enabled),
      port:             config.processes[d.name]?.port || "",
      running:          running.has(d.name),
      runningInteractive: runningPty.has(d.name),
    })),
    cloudflare: { ...cf.status(), recentLogs: cf.recentLogs() },
    terminal:   { enabled: Boolean(pty) },
    network:    readNetStats(),
    meta:       { appsDir: path.relative(ROOT, APPS_DIR) || ".", dataDir: path.relative(ROOT, DATA_DIR) || "." }
  };
}

function getShell() {
  if (process.platform === "win32") return process.env.ComSpec || "cmd.exe";
  return process.env.SHELL || "/bin/bash";
}

function safeCwd(input) {
  try {
    const full = path.resolve(ROOT, String(input || "."));
    if (fs.existsSync(full)) return full;
  } catch { }
  return ROOT;
}

function readConfig() {
  if (!fs.existsSync(configFile)) return { processes: {} };
  try { return JSON.parse(fs.readFileSync(configFile, "utf8")); } catch { return { processes: {} }; }
}

function writeConfig() {
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

function str(v)        { return String(v || "").trim(); }

function merge(a, b) {
  const base = (a && typeof a === "object" && !Array.isArray(a)) ? a : {};
  const next = (b && typeof b === "object" && !Array.isArray(b)) ? b : {};
  return { ...base, ...next };
}

function cfOnly(req, res, next) {
  if (!CF_ONLY) return next();
  const ip = req.socket.remoteAddress || "";
  if (isCloudflareTrusted(ip)) return next();
  slog("warn", `Blocked non-CF request from ${ip} ${req.method} ${req.path}`);
  res.status(403).send("Access restricted to Cloudflare network.");
}

function auth(req, res, next) {
  if (!AUTH_USER || !AUTH_PASS) return next();
  const ip = req.socket.remoteAddress || "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return next();
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="WispNodes"');
    return res.status(401).send("Authentication required.");
  }
  const raw = Buffer.from(header.slice(6), "base64").toString();
  const sep = raw.indexOf(":");
  const user = sep >= 0 ? raw.slice(0, sep) : raw;
  const pass = sep >= 0 ? raw.slice(sep + 1) : "";
  if (!eq(user, AUTH_USER) || !eq(pass, AUTH_PASS)) return res.status(403).send("Access denied.");
  next();
}

function eq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

process.on("uncaughtException",  err => console.error("[uncaught]",  err.stack || err));
process.on("unhandledRejection", err => console.error("[unhandled]", err && err.stack ? err.stack : err));
