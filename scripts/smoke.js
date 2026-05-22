"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const ROOT     = path.resolve(__dirname, "..");
const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const USER     = process.env.DASHBOARD_USERNAME || "";
const PASS     = process.env.DASHBOARD_PASSWORD || "";

let passed = 0, failed = 0;

function ok(name) { console.log(`  PASS  ${name}`); passed++; }
function fail(name, reason) { console.error(`  FAIL  ${name}: ${reason}`); failed++; }

function req(method, pathname, { expectStatus = 200, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth && USER && PASS)
      headers["Authorization"] = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
    const r = http.request(`${BASE_URL}${pathname}`, { method, headers }, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    r.on("error", reject);
    r.setTimeout(5000, () => { r.destroy(); reject(new Error("timeout")); });
    r.end();
  });
}

async function run() {
  console.log(`\nWispNodes smoke tests — ${BASE_URL}\n`);

  // ── 1. Filesystem ────────────────────────────────────────────────────────────
  console.log("Filesystem");
  const appsDir = path.join(ROOT, process.env.APPS_DIR || "apps");
  if (fs.existsSync(appsDir)) {
    const dirs = fs.readdirSync(appsDir, { withFileTypes: true }).filter(e => e.isDirectory());
    if (dirs.length > 0) ok(`apps dir has ${dirs.length} subdirectory(s): ${dirs.map(d => d.name).join(", ")}`);
    else                  fail("apps dir subdirectories", `${appsDir} exists but has no subdirectories`);
  } else {
    fail("apps dir exists", `${appsDir} not found`);
  }

  // ── 2. Server reachable ──────────────────────────────────────────────────────
  console.log("\nHTTP");
  try {
    const r = await req("GET", "/");
    if (r.status === 200) ok("GET / returns 200");
    else fail("GET /", `expected 200, got ${r.status}`);
  } catch (e) { fail("GET /", e.message); }

  // ── 3. Auth (skipped from localhost — bypass is intentional) ─────────────────

  // ── 4. Health endpoint ───────────────────────────────────────────────────────
  console.log("\nHealth");
  let health = null;
  try {
    const r = await req("GET", "/api/health");
    if (r.status !== 200) { fail("GET /api/health", `status ${r.status}`); }
    else {
      health = JSON.parse(r.body);
      ok("GET /api/health returns 200");
    }
  } catch (e) { fail("GET /api/health", e.message); }

  if (health) {
    if (health.apps && health.apps.count > 0) ok(`apps discovered: ${health.apps.count}`);
    else fail("apps discovered", `count is ${health?.apps?.count ?? "missing"} — check ${appsDir}`);

    if (health.pm2 && health.pm2.ok) ok("PM2 connected");
    else fail("PM2", `not connected — ${JSON.stringify(health?.pm2)}`);

    if (health.terminal && health.terminal.enabled) ok("node-pty terminal enabled");
    else fail("node-pty", "terminal disabled — run npm install");
  }

  // ── 5. SSE stream ────────────────────────────────────────────────────────────
  console.log("\nSSE");
  await new Promise(resolve => {
    const headers = {};
    if (USER && PASS)
      headers["Authorization"] = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
    const r = http.request(`${BASE_URL}/api/stream`, { headers }, res => {
      if (res.statusCode !== 200) { fail("SSE /api/stream", `status ${res.statusCode}`); res.destroy(); return resolve(); }
      let buf = "";
      const t = setTimeout(() => { fail("SSE state event", "no state event received within 10s"); r.destroy(); resolve(); }, 10000);
      res.on("data", chunk => {
        buf += chunk;
        if (buf.includes("event: state")) {
          clearTimeout(t);
          const match = buf.match(/data: ({.+})/);
          if (match) {
            try {
              const state = JSON.parse(match[1]);
              if (Array.isArray(state.discovered))
                ok(`SSE state received — ${state.discovered.length} app(s) in discovered`);
              else
                fail("SSE discovered field", "state.discovered is missing or not an array");
            } catch { fail("SSE state parse", "could not parse state JSON"); }
          } else {
            ok("SSE state event received");
          }
          r.destroy();
          resolve();
        }
      });
    });
    r.on("error", e => { fail("SSE connection", e.message); resolve(); });
    r.setTimeout(10000, () => { fail("SSE connection", "timeout"); r.destroy(); resolve(); });
    r.end();
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
