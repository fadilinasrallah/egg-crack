(function () {
  "use strict";

  // ── DOM ───────────────────────────────────────────────────────────────────
  const connEl       = document.getElementById("conn");
  const cfBadge      = document.getElementById("cf-badge");
  const cfPanel      = document.getElementById("cf-panel");
  const cfLogs       = document.getElementById("cf-logs");
  const formStart    = document.getElementById("form-start");
  const discoveredEl = document.getElementById("discovered");
  const appsDirHint  = document.getElementById("apps-dir-hint");
  const processesEl  = document.getElementById("processes");
  const procCount    = document.getElementById("proc-count");
  const bottomPanel  = document.getElementById("bottom-panel");
  const resizeHandle = document.getElementById("resize-handle");
  const tabBar       = document.getElementById("tab-bar");
  const tabContent   = document.getElementById("tab-content");
  const toastsEl     = document.getElementById("toasts");
  const btnNewTerm   = document.getElementById("btn-new-term");
  const btnHealth    = document.getElementById("btn-health");

  // ── Terminal colour theme ─────────────────────────────────────────────────
  const TERM_THEME = {
    background:    "#0d1117", foreground:    "#e6edf3",
    cursor:        "#58a6ff", cursorAccent:  "#0d1117",
    selectionBackground: "rgba(88,166,255,0.25)",
    black: "#484f58", red: "#f85149", green: "#3fb950", yellow: "#d29922",
    blue:  "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
    brightBlack:   "#6e7681", brightRed:  "#ff7b72", brightGreen: "#56d364",
    brightYellow:  "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
    brightCyan:    "#56d4dd", brightWhite:"#f0f6fc"
  };

  // ── State ─────────────────────────────────────────────────────────────────
  const tabs     = new Map(); // id → tab object
  let activeTabId = null;
  let termToken   = null;
  let termEnabled = false;

  // Log tab state
  let logTarget = null;
  let logTimer  = null;

  // Panel height
  let panelHeight = 340;

  // ── Boot ──────────────────────────────────────────────────────────────────
  (async function boot() {
    try {
      const data = await call("GET", "/api/terminal-token");
      termToken   = data.token;
      termEnabled = Boolean(data.enabled);
    } catch { }
    connectSSE();
  })();

  // ── SSE ───────────────────────────────────────────────────────────────────
  function connectSSE() {
    const sse = new EventSource("/api/stream");
    sse.addEventListener("state", e => { render(JSON.parse(e.data)); setConn("live"); });
    sse.onerror = () => setConn("lost");
    sse.onopen  = () => setConn("live");
  }

  function setConn(s) {
    connEl.className = `conn conn-${s}`;
    connEl.textContent = s === "live" ? "live" : "reconnecting";
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render(state) {
    renderProcesses(state.processes || []);
    renderDiscovered(state.discovered || []);
    renderCloudflare(state.cloudflare || {});
    if (state.meta) appsDirHint.textContent = state.meta.appsDir;
    if (state.terminal) termEnabled = state.terminal.enabled;
  }

  function renderProcesses(procs) {
    procCount.textContent = procs.length;
    if (!procs.length) {
      processesEl.innerHTML = '<div class="empty">No running processes. Use the form on the left to start one.</div>';
      return;
    }
    processesEl.innerHTML = procs.map(p => {
      const on  = p.status === "online";
      const cls = on ? "badge-online" : p.status === "stopped" ? "badge-stopped" : "badge-offline";
      const sel = logTarget === p.name ? " selected" : "";
      return `
      <div class="proc-card${sel}">
        <div class="proc-header">
          <span class="proc-name">${x(p.name)}</span>
          <span class="badge ${cls}">${x(p.status)}</span>
        </div>
        ${p.cwd ? `<div class="proc-cwd">${x(p.cwd)}</div>` : ""}
        ${on ? `
        <div class="proc-stats">
          <div class="stat"><span class="stat-val">${p.cpu}%</span><span class="stat-lbl">CPU</span></div>
          <div class="stat"><span class="stat-val">${fmtMem(p.memory)}</span><span class="stat-lbl">MEM</span></div>
          <div class="stat"><span class="stat-val">${p.restarts}</span><span class="stat-lbl">Restarts</span></div>
          ${p.port ? `<div class="stat"><span class="stat-val">${x(p.port)}</span><span class="stat-lbl">Port</span></div>` : ""}
        </div>` : ""}
        <div class="proc-actions">
          <button class="btn btn-sm" data-act="logs"    data-name="${x(p.name)}">Logs</button>
          <button class="btn btn-sm btn-ghost" data-act="shell" data-name="${x(p.name)}" data-cwd="${x(p.cwd || ".")}" ${termEnabled ? "" : "disabled"} title="${termEnabled ? "Open shell in this app's directory" : "Install node-pty to enable terminal"}">Shell</button>
          <button class="btn btn-sm" data-act="restart" data-name="${x(p.name)}">Restart</button>
          <button class="btn btn-sm btn-ghost"  data-act="stop"    data-name="${x(p.name)}">Stop</button>
          <button class="btn btn-sm btn-danger" data-act="delete"  data-name="${x(p.name)}">Delete</button>
        </div>
      </div>`;
    }).join("");
  }

  function renderDiscovered(apps) {
    if (!apps.length) {
      discoveredEl.innerHTML = '<div class="empty">No app folders found.</div>';
      return;
    }
    discoveredEl.innerHTML = apps.map(a => `
      <div class="app-row">
        <div class="app-info">
          <div class="app-name">${x(a.name)} ${a.running ? '<span style="color:var(--green);font-size:10px" title="Running">●</span>' : ""}</div>
          <div class="app-cmd">${x(a.command || "no command detected")}</div>
        </div>
        <div class="app-actions">
          <button class="btn btn-xs btn-primary" data-act="quick-start"
            data-name="${x(a.name)}" data-cwd="${x(a.cwd)}" data-cmd="${x(a.command || "")}" data-port="${x(a.port || "")}"
            ${a.running ? "disabled" : ""}>Start</button>
          <button class="btn btn-xs btn-ghost" data-act="configure"
            data-name="${x(a.name)}" data-cwd="${x(a.cwd)}" data-cmd="${x(a.command || "")}" data-port="${x(a.port || "")}">Edit</button>
        </div>
      </div>`).join("");
  }

  function renderCloudflare(cf) {
    const configured = Boolean(cf.configured);
    const running    = Boolean(cf.running);
    const external   = Boolean(cf.external);

    cfBadge.hidden = false;
    if (!configured && !running) {
      cfBadge.hidden = true;
    } else if (external) {
      cfBadge.textContent = "● Tunnel running (external)";
      cfBadge.style.color = "var(--green)";
    } else if (running) {
      cfBadge.textContent = "● Tunnel running";
      cfBadge.style.color = "var(--green)";
    } else if (configured) {
      cfBadge.textContent = "○ Tunnel stopped";
      cfBadge.style.color = "var(--muted)";
    }

    // Only show log panel if WispNodes manages the tunnel.
    cfPanel.hidden = !configured || external;
    if (!cfPanel.hidden && cf.recentLogs) cfLogs.textContent = cf.recentLogs;
  }

  // ── Delegated clicks ──────────────────────────────────────────────────────
  document.addEventListener("click", async e => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act  = btn.dataset.act;
    const name = btn.dataset.name;

    if (act === "configure") {
      document.getElementById("i-name").value  = name;
      document.getElementById("i-cwd").value   = btn.dataset.cwd  || "";
      document.getElementById("i-cmd").value   = btn.dataset.cmd  || "";
      document.getElementById("i-port").value  = btn.dataset.port || "";
      formStart.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("i-port").focus();
      return;
    }

    if (act === "delete" && !confirm(`Delete "${name}" from PM2?\nThis cannot be undone.`)) return;

    await withBtn(btn, async () => {
      switch (act) {
        case "quick-start":
          await call("POST", `/api/processes/${enc(name)}/start`, {
            name, cwd: btn.dataset.cwd, command: btn.dataset.cmd, port: btn.dataset.port
          });
          toast(`Started ${name}`, "success");
          break;

        case "logs":
          openLogTab(name);
          btn.closest(".proc-card")?.classList.add("selected");
          break;

        case "shell":
          openShellTab(btn.dataset.cwd || ".", name);
          break;

        case "restart":
          await call("POST", `/api/processes/${enc(name)}/restart`);
          toast(`Restarted ${name}`, "success");
          if (logTarget === name) pollLogs();
          break;

        case "stop":
          await call("POST", `/api/processes/${enc(name)}/stop`);
          toast(`Stopped ${name}`, "info");
          break;

        case "delete":
          await call("DELETE", `/api/processes/${enc(name)}`);
          toast(`Deleted ${name}`, "info");
          if (logTarget === name) closeLogTab();
          break;
      }
    });
  });

  // ── Start form ────────────────────────────────────────────────────────────
  formStart.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = formStart.querySelector("[type=submit]");
    const fd  = new FormData(formStart);
    const payload = {
      name:    String(fd.get("name")    || "").trim(),
      cwd:     String(fd.get("cwd")     || "").trim(),
      command: String(fd.get("command") || "").trim(),
      port:    String(fd.get("port")    || "").trim()
    };
    if (!payload.name) { toast("Name is required.", "error"); return; }
    await withBtn(btn, async () => {
      await call("POST", `/api/processes/${enc(payload.name)}/start`, payload);
      formStart.reset();
      toast(`Started ${payload.name}`, "success");
    });
  });

  // ── Health button ─────────────────────────────────────────────────────────
  btnHealth.addEventListener("click", () => openHealthTab());

  // ── New terminal button & Ctrl+` shortcut ─────────────────────────────────
  btnNewTerm.addEventListener("click", () => {
    if (!termEnabled) { toast("Terminal unavailable. Run npm install in the WispNodes directory.", "error"); return; }
    openShellTab(".", "Shell");
  });

  document.addEventListener("keydown", e => {
    if (e.ctrlKey && e.key === "`") {
      e.preventDefault();
      if (bottomPanel.hidden) {
        if (termEnabled) openShellTab(".", "Shell");
      } else {
        // Toggle: if only the panel is showing and user presses again, focus active terminal
        const active = tabs.get(activeTabId);
        if (active && active.type === "shell" && active.term) active.term.focus();
      }
    }
  });

  // ── Tab management ────────────────────────────────────────────────────────
  const LOG_TAB_ID = "tab-log";

  function openLogTab(processName) {
    logTarget = processName;
    if (!tabs.has(LOG_TAB_ID)) {
      const pane = document.createElement("div");
      pane.className = "tab-pane log-pane";
      pane.innerHTML = `
        <div class="log-toolbar">
          <span class="log-proc-tag" id="log-proc-tag">${x(processName)}</span>
          <label class="toggle" style="margin-left:auto">
            <input id="autoscroll" type="checkbox" checked> auto-scroll
          </label>
          <button class="btn btn-xs btn-ghost" data-act-panel="close-log">✕</button>
        </div>
        <pre class="log-view" id="log-view"></pre>`;
      tabs.set(LOG_TAB_ID, { id: LOG_TAB_ID, type: "log", title: processName, pane });
      tabContent.appendChild(pane);

      pane.querySelector("[data-act-panel='close-log']").addEventListener("click", closeLogTab);
    } else {
      tabs.get(LOG_TAB_ID).title = processName;
      const tag = document.getElementById("log-proc-tag");
      if (tag) tag.textContent = processName;
    }
    activateTab(LOG_TAB_ID);
    showPanel();
    startLogPolling();
  }

  function closeLogTab() {
    stopLogPolling();
    logTarget = null;
    document.querySelectorAll(".proc-card.selected").forEach(el => el.classList.remove("selected"));
    closeTab(LOG_TAB_ID);
  }

  function openShellTab(cwd, title) {
    const id   = "tab-shell-" + Date.now();
    const pane = document.createElement("div");
    pane.className = "tab-pane shell-pane";
    const tab = { id, type: "shell", title: title || "Shell", cwd, pane, term: null, fitAddon: null, ws: null };
    tabs.set(id, tab);
    tabContent.appendChild(pane);
    activateTab(id);
    showPanel();
    spawnTerminal(tab);
  }

  function activateTab(id) {
    if (!tabs.has(id)) return;
    activeTabId = id;
    for (const [tid, t] of tabs) {
      t.pane.classList.toggle("active", tid === id);
    }
    renderTabBar();
    // Re-fit the terminal after the pane becomes visible.
    const tab = tabs.get(id);
    if (tab && tab.type === "shell" && tab.fitAddon) {
      requestAnimationFrame(() => tab.fitAddon.fit());
    }
    // Resume log polling if log tab is activated.
    if (id === LOG_TAB_ID && logTarget) startLogPolling();
    else if (id !== LOG_TAB_ID) stopLogPolling();
  }

  function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    // Clean up shell resources.
    if (tab.type === "shell") {
      if (tab.ws)   { try { tab.ws.close();  } catch { } }
      if (tab.term) { try { tab.term.dispose(); } catch { } }
    }
    tab.pane.remove();
    tabs.delete(id);
    // Activate the next available tab, or hide the panel.
    if (activeTabId === id) {
      const remaining = [...tabs.keys()];
      if (remaining.length) activateTab(remaining[remaining.length - 1]);
      else hidePanel();
    }
    renderTabBar();
  }

  function renderTabBar() {
    const tabEls  = [];
    for (const [id, tab] of tabs) {
      const isLog    = tab.type === "log";
      const isHealth = tab.type === "health";
      const icon     = isHealth ? "⚙" : isLog ? "≡" : "$";
      const active  = id === activeTabId ? " active" : "";
      tabEls.push(`
        <button class="tab${active}" data-tab-id="${x(id)}">
          <span class="tab-icon">${icon}</span>
          ${x(tab.title)}
          <span class="tab-close" data-close-tab="${x(id)}">✕</span>
        </button>`);
    }
    tabEls.push(`<button class="tab-add" id="tab-add-btn" title="New terminal">+</button>`);
    tabBar.innerHTML = tabEls.join("");

    // Tab clicks
    tabBar.querySelectorAll(".tab[data-tab-id]").forEach(el => {
      el.addEventListener("click", e => {
        if (e.target.closest("[data-close-tab]")) return;
        activateTab(el.dataset.tabId);
      });
    });

    // Close clicks
    tabBar.querySelectorAll("[data-close-tab]").forEach(el => {
      el.addEventListener("click", e => {
        e.stopPropagation();
        const id = el.dataset.closeTab;
        if (id === LOG_TAB_ID) closeLogTab();
        else closeTab(id);
      });
    });

    // Health tab add button in tab bar also acts as a shortcut
    tabBar.querySelectorAll("[data-open-health]").forEach(el => {
      el.addEventListener("click", () => openHealthTab());
    });

    // Add terminal
    const addBtn = document.getElementById("tab-add-btn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        if (!termEnabled) { toast("Terminal unavailable. Run npm install.", "error"); return; }
        openShellTab(".", "Shell");
      });
    }
  }

  // ── Panel show/hide/resize ────────────────────────────────────────────────
  function showPanel() {
    if (!bottomPanel.hidden) return;
    bottomPanel.hidden = false;
    setPanelHeight(panelHeight);
  }

  function hidePanel() {
    bottomPanel.hidden = true;
    document.body.style.paddingBottom = "";
    activeTabId = null;
  }

  function setPanelHeight(h) {
    panelHeight = Math.max(160, Math.min(h, window.innerHeight * 0.80));
    bottomPanel.style.height = panelHeight + "px";
    document.body.style.paddingBottom = panelHeight + "px";
    fitActiveTerminal();
  }

  function fitActiveTerminal() {
    const tab = tabs.get(activeTabId);
    if (tab && tab.fitAddon) tab.fitAddon.fit();
  }

  // Drag to resize
  resizeHandle.addEventListener("mousedown", e => {
    e.preventDefault();
    const startY  = e.clientY;
    const startH  = bottomPanel.offsetHeight;

    const onMove = ev => setPanelHeight(startH + (startY - ev.clientY));
    const onUp   = ()  => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  });

  window.addEventListener("resize", () => { if (!bottomPanel.hidden) fitActiveTerminal(); });

  // ── xterm terminal ────────────────────────────────────────────────────────
  function spawnTerminal(tab) {
    const term = new Terminal({
      cursorBlink:       true,
      fontSize:          13,
      fontFamily:        '"JetBrains Mono","SFMono-Regular",Consolas,monospace',
      theme:             TERM_THEME,
      scrollback:        5000,
      allowTransparency: true,
      macOptionIsMeta:   true
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(tab.pane);
    fitAddon.fit();

    tab.term     = term;
    tab.fitAddon = fitAddon;

    // Fit when the pane resizes.
    const ro = new ResizeObserver(() => {
      if (activeTabId === tab.id && fitAddon) fitAddon.fit();
    });
    ro.observe(tab.pane);

    // WebSocket connection.
    const proto  = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ cwd: tab.cwd, token: termToken || "" });
    const ws     = new WebSocket(`${proto}//${location.host}/api/terminal?${params}`);
    ws.binaryType = "arraybuffer";
    tab.ws = ws;

    term.write("\x1b[90mConnecting…\x1b[0m\r\n");

    ws.onopen = () => {
      term.write("\x1b[2K\x1b[1A\x1b[2K"); // clear "Connecting…" line
      ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = e => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
      } else {
        try {
          const msg = JSON.parse(e.data);
          if (msg.t === "exit") {
            term.write(`\r\n\x1b[90m── process exited (${msg.code}) ──\x1b[0m\r\n`);
          } else if (msg.t === "error") {
            term.write(`\r\n\x1b[31mError: ${msg.msg}\x1b[0m\r\n`);
          }
        } catch { }
      }
    };

    ws.onclose = () => {
      term.write("\r\n\x1b[90m── connection closed ──\x1b[0m\r\n");
    };

    ws.onerror = () => {
      term.write("\r\n\x1b[31m── WebSocket error ──\x1b[0m\r\n");
    };

    // Input: forward keystrokes to PTY.
    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "i", d: data }));
      }
    });

    // Resize: notify PTY.
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "resize", cols, rows }));
      }
    });

    // Update tab title with the shell name.
    tabs.get(tab.id).title = `Shell: ${tab.cwd === "." ? "/" : tab.cwd}`;
    renderTabBar();

    term.focus();
  }

  // ── Health tab ────────────────────────────────────────────────────────────
  const HEALTH_TAB_ID = "tab-health";

  function openHealthTab() {
    if (tabs.has(HEALTH_TAB_ID)) { activateTab(HEALTH_TAB_ID); showPanel(); return; }
    const pane = document.createElement("div");
    pane.className = "tab-pane health-pane";
    pane.innerHTML = `
      <div class="health-toolbar">
        <strong>Setup Health</strong>
        <span style="flex:1"></span>
        <button class="btn btn-xs btn-ghost" id="health-refresh-btn">Refresh</button>
        <button class="btn btn-xs btn-ghost" data-close-health>✕</button>
      </div>
      <div class="health-content" id="health-content">
        <span class="health-loading">Loading…</span>
      </div>`;
    tabs.set(HEALTH_TAB_ID, { id: HEALTH_TAB_ID, type: "health", title: "Health", pane });
    tabContent.appendChild(pane);
    activateTab(HEALTH_TAB_ID);
    showPanel();
    pane.querySelector("#health-refresh-btn").addEventListener("click", () => loadHealth());
    pane.querySelector("[data-close-health]").addEventListener("click", () => closeTab(HEALTH_TAB_ID));
    loadHealth();
  }

  async function loadHealth() {
    const content = document.getElementById("health-content");
    if (!content) return;
    content.innerHTML = '<span class="health-loading">Loading…</span>';
    try {
      const h = await call("GET", "/api/health");
      content.innerHTML = renderHealth(h);
      // auto-scroll startup log to bottom
      const hlog = content.querySelector(".hlog");
      if (hlog) hlog.scrollTop = hlog.scrollHeight;
    } catch (err) {
      content.innerHTML = `<div class="health-error">Failed: ${x(err.message)}</div>`;
    }
  }

  function renderHealth(h) {
    const chk = (ok, warn) => ok
      ? `<span class="hstatus hstatus-ok">✓</span>`
      : warn
        ? `<span class="hstatus hstatus-warn">!</span>`
        : `<span class="hstatus hstatus-err">✗</span>`;

    const cfS   = h.cloudflare || {};
    const cfOk  = Boolean(cfS.running);
    const cfMsg = cfS.external   ? "running (external — WispNodes did not start it)"
                : cfS.running    ? "running (managed)"
                : cfS.configured ? `stopped — check startup log for cloudflared errors`
                : "not configured (CF_TUNNEL_TOKEN not set)";

    const uptime = h.uptime || 0;
    const uptimeStr = uptime < 60   ? `${uptime}s`
                    : uptime < 3600 ? `${Math.floor(uptime/60)}m ${uptime%60}s`
                    : `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`;

    const logLines = (h.startupLog || []).map(e => {
      const ts  = e.ts ? e.ts.slice(11, 23) : "??:??:??.???";
      const cls = e.level === "error" ? "hlog-err"
                : e.level === "warn"  ? "hlog-warn"
                : "hlog-info";
      return `<div class="hlog-line ${cls}">[${x(ts)}] [${x(e.level || "info")}] ${x(e.msg)}</div>`;
    }).join("") || `<div class="hlog-line hlog-info">(no events recorded yet)</div>`;

    return `
      <div class="health-grid">
        <div class="hrow"><div class="hkey">Node.js</div><div class="hval">${x(h.node||"?")} · ${x(h.platform||"?")}/${x(h.arch||"?")}</div></div>
        <div class="hrow"><div class="hkey">Uptime</div><div class="hval">${uptimeStr}</div></div>
        <div class="hrow"><div class="hkey">Port</div><div class="hval">${x(String(h.config?.port||"?"))}</div></div>
        <div class="hsep"></div>
        <div class="hrow">${chk(h.terminal?.enabled)}<div class="hkey">Terminal (node-pty)</div><div class="hval">${h.terminal?.enabled ? "enabled" : "disabled — run npm install"}</div></div>
        <div class="hrow">${chk(h.pm2?.ok)}<div class="hkey">PM2</div><div class="hval">${h.pm2?.ok ? `connected · ${h.pm2.processes} process(es)` : "unavailable"}</div></div>
        <div class="hrow">${chk(cfOk, cfS.configured && !cfOk)}<div class="hkey">Cloudflare Tunnel</div><div class="hval">${cfMsg}</div></div>
        <div class="hrow">${chk(h.config?.auth)}<div class="hkey">Auth</div><div class="hval">${h.config?.auth ? "enabled" : "disabled (no credentials set)"}</div></div>
        <div class="hsep"></div>
        <div class="hrow"><div class="hkey">Apps dir</div><div class="hval">${x(h.config?.appsDir||"?")}</div></div>
        <div class="hrow"><div class="hkey">Data dir</div><div class="hval">${x(h.config?.dataDir||"?")}</div></div>
        <div class="hrow"><div class="hkey">Discovered apps</div><div class="hval">${h.apps?.count ?? 0}</div></div>
        <div class="hrow"><div class="hkey">CF binary</div><div class="hval">${cfS.binaryReady ? "present" : "not downloaded"}</div></div>
        <div class="hsep"></div>
        <div class="hlog-header">Startup &amp; Runtime Log</div>
        <div class="hlog">${logLines}</div>
      </div>`;
  }

  // ── Log polling ───────────────────────────────────────────────────────────
  function startLogPolling() {
    stopLogPolling();
    pollLogs();
    logTimer = setInterval(pollLogs, 2000);
  }

  function stopLogPolling() {
    clearInterval(logTimer);
    logTimer = null;
  }

  async function pollLogs() {
    if (!logTarget) return;
    try {
      const data = await call("GET", `/api/processes/${enc(logTarget)}/logs?lines=200`);
      const text = [data.stdout, data.stderr].filter(Boolean).join("\n\n── stderr ──\n\n") || "(no output yet)";
      const logView = document.getElementById("log-view");
      if (!logView) return;
      const autoscrollEl = document.getElementById("autoscroll");
      const atBottom = logView.scrollHeight - logView.scrollTop <= logView.clientHeight + 80;
      logView.textContent = text;
      if (autoscrollEl && autoscrollEl.checked && atBottom) logView.scrollTop = logView.scrollHeight;
    } catch { }
  }

  // ── HTTP helper ───────────────────────────────────────────────────────────
  async function call(method, url, body) {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const t = await res.text(); msg = JSON.parse(t).error || t || msg; } catch { }
      throw new Error(msg);
    }
    return res.json().catch(() => null);
  }

  // ── Button loading wrapper ────────────────────────────────────────────────
  async function withBtn(btn, fn) {
    if (btn.disabled) return;
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "…";
    try   { await fn(); }
    catch (err) { toast(err.message, "error"); }
    finally { btn.disabled = false; btn.textContent = orig; }
  }

  // ── Toasts ────────────────────────────────────────────────────────────────
  function toast(msg, type = "info") {
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    toastsEl.appendChild(el);
    el.getBoundingClientRect();
    el.classList.add("show");
    const ttl = type === "error" ? 7000 : 3500;
    const t = setTimeout(() => dismiss(el), ttl);
    el.addEventListener("click", () => { clearTimeout(t); dismiss(el); });
  }

  function dismiss(el) {
    el.classList.remove("show");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function x(v) {
    return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function enc(v)  { return encodeURIComponent(String(v)); }
  function fmtMem(b) {
    if (!b) return "0 B";
    const u = ["B","KB","MB","GB"];
    let i = 0, v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  }
})();
