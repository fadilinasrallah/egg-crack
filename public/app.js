(function () {
  "use strict";

  // ── DOM ───────────────────────────────────────────────────────────────────
  const connEl       = document.getElementById("conn");
  const cfBadge      = document.getElementById("cf-badge");
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
  const netStatsEl   = document.getElementById("net-stats");

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

  // CF log tab state
  const CF_LOG_TAB_ID = "tab-cf-log";
  let cfLogOpened = false;

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
    renderNetwork(state.network || null);
    if (state.meta) appsDirHint.textContent = state.meta.appsDir;
    if (state.terminal) termEnabled = state.terminal.enabled;
  }

  function renderNetwork(net) {
    if (!net) { netStatsEl.hidden = true; return; }
    netStatsEl.hidden = false;
    netStatsEl.innerHTML =
      `<span class="net-rx">↓ ${fmtRate(net.rxRate)}</span>` +
      `<span class="net-tx">↑ ${fmtRate(net.txRate)}</span>`;
  }

  function renderProcesses(procs) {
    procCount.textContent = procs.length;
    if (!procs.length) {
      processesEl.innerHTML = '<div class="empty" style="padding:24px 16px">No running processes. Start one from the Discovered Apps panel.</div>';
      return;
    }
    const rows = procs.map(p => {
      const on     = p.status === "online";
      const dotCls = on                        ? "dot-online"
                   : p.status === "stopped"   ? "dot-stopped"
                   : p.status === "launching" ? "dot-launching"
                   : "dot-errored";
      const shellDisabled = termEnabled ? "" : " disabled";
      const shellTitle    = termEnabled ? "Open shell in this app's directory" : "Install node-pty to enable terminal";
      const attachTitle   = p.interactive ? "Attach live terminal (PTY)" : "Stream live output";
      return `
      <tr>
        <td class="proc-td-dot"><span class="proc-dot ${dotCls}" title="${x(p.status)}"></span></td>
        <td class="proc-td-name">
          <div class="proc-info">
            <span class="proc-name">${x(p.name)}</span>
            ${p.cwd ? `<span class="proc-cwd">${x(p.cwd)}${p.dirSize ? ` · ${fmtMem(p.dirSize)}` : ""}</span>` : ""}
          </div>
        </td>
        <td class="proc-metric${on ? "" : " dim"}">${on && p.uptime ? fmtUptime(p.uptime) : "—"}</td>
        <td class="proc-metric${on ? "" : " dim"}">${on ? p.cpu + "%" : "—"}</td>
        <td class="proc-metric${on ? "" : " dim"}">${on ? fmtMem(p.memory) : "—"}</td>
        <td class="proc-metric${on ? "" : " dim"}">${on && p.port ? x(p.port) : "—"}</td>
        <td class="proc-restarts">${p.restarts}</td>
        <td class="proc-td-btns">
          <div class="proc-btns">
            <button class="btn btn-xs btn-pty"   data-act="attach"  data-name="${x(p.name)}" data-interactive="${p.interactive ? "1" : ""}" title="${attachTitle}">Attach</button>
            <button class="btn btn-xs btn-ghost"  data-act="shell"   data-name="${x(p.name)}" data-cwd="${x(p.cwd || ".")}"${shellDisabled} title="${shellTitle}">Shell</button>
            <button class="btn btn-xs btn-ghost"  data-act="restart" data-name="${x(p.name)}" title="Restart">↺</button>
            <button class="btn btn-xs btn-ghost"  data-act="stop"    data-name="${x(p.name)}" title="Stop">■</button>
            <button class="btn btn-xs btn-danger" data-act="delete"  data-name="${x(p.name)}" title="Delete">✕</button>
          </div>
        </td>
      </tr>`;
    }).join("");
    processesEl.innerHTML = `
      <table class="proc-table">
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th class="ta-r">Uptime</th>
            <th class="ta-r">CPU</th>
            <th class="ta-r">Memory</th>
            <th class="ta-r">Port</th>
            <th class="ta-r">Restarts</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderDiscovered(apps) {
    if (!apps.length) {
      discoveredEl.innerHTML = '<div class="empty">No app folders found.</div>';
      return;
    }
    discoveredEl.innerHTML = apps.map(a => {
      // Show green dot only when running interactively (PTY).
      // When running as PM2 (non-interactive) the user still needs to be able
      // to click Start to switch to PTY / interactive mode.
      const dot    = a.runningInteractive ? '<span style="color:var(--green);font-size:10px" title="Running (interactive)">●</span>' : "";
      const label  = a.running && !a.runningInteractive ? "Restart as PTY" : "Start";
      const disabl = a.runningInteractive ? "disabled" : "";
      const title  = a.runningInteractive
        ? "Already running interactively — use Attach to connect"
        : a.running
          ? "Running as PM2 — click to restart as interactive PTY process"
          : "";
      return `
      <div class="app-row">
        <div class="app-info">
          <div class="app-name">${x(a.name)} ${dot}</div>
          <div class="app-cmd">${x(a.command || "no command detected")}</div>
        </div>
        <div class="app-actions">
          <button class="btn btn-xs btn-primary" data-act="quick-start"
            data-name="${x(a.name)}" data-cwd="${x(a.cwd)}" data-cmd="${x(a.command || "")}" data-port="${x(a.port || "")}"
            ${disabl} title="${x(title)}">${label}</button>
        </div>
      </div>`;
    }).join("");
  }

  function renderCloudflare(cf) {
    const configured = Boolean(cf.configured);
    const running    = Boolean(cf.running);
    const external   = Boolean(cf.external);
    const showLog    = configured && !external;

    cfBadge.hidden = !configured && !running;
    if (!cfBadge.hidden) {
      if (external) {
        cfBadge.textContent = "● Tunnel (external)";
        cfBadge.style.color = "var(--green)";
      } else if (running) {
        cfBadge.textContent = "● Tunnel";
        cfBadge.style.color = "var(--green)";
      } else {
        cfBadge.textContent = "○ Tunnel stopped";
        cfBadge.style.color = "var(--muted)";
      }
      cfBadge.style.cursor = showLog ? "pointer" : "";
      cfBadge.title = showLog ? "Click to view tunnel logs" : "";
    }

    if (showLog && cf.recentLogs) {
      if (!cfLogOpened) { openCfLogTab(); cfLogOpened = true; }
      updateCfLogTab(cf.recentLogs);
    }
  }

  function openCfLogTab() {
    if (tabs.has(CF_LOG_TAB_ID)) { activateTab(CF_LOG_TAB_ID); showPanel(); return; }
    const pane = document.createElement("div");
    pane.className = "tab-pane log-pane";
    pane.innerHTML = `
      <div class="log-toolbar">
        <span class="log-proc-tag">Cloudflare Tunnel</span>
      </div>
      <pre class="log-view" id="cf-log-view"></pre>`;
    tabs.set(CF_LOG_TAB_ID, { id: CF_LOG_TAB_ID, type: "cflog", title: "Tunnel", pane });
    tabContent.appendChild(pane);
    activateTab(CF_LOG_TAB_ID);
    showPanel();
  }

  function updateCfLogTab(logs) {
    const view = document.getElementById("cf-log-view");
    if (!view) return;
    const atBottom = view.scrollHeight - view.scrollTop <= view.clientHeight + 40;
    view.textContent = logs || "(no logs yet)";
    if (atBottom) view.scrollTop = view.scrollHeight;
  }

  // ── Delegated clicks ──────────────────────────────────────────────────────
  document.addEventListener("click", async e => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act  = btn.dataset.act;
    const name = btn.dataset.name;

    if (act === "delete" && !confirm(`Delete "${name}" from PM2?\nThis cannot be undone.`)) return;

    // quick-start: open an interactive attach tab immediately so the user can
    // watch install progress and type to the process once it starts.
    if (act === "quick-start") {
      btn.disabled    = true;
      btn.textContent = "Starting…";
      openAttachTab(name, true); // interactive — user can type
      call("POST", `/api/processes/${enc(name)}/start`, {
        name, cwd: btn.dataset.cwd, command: btn.dataset.cmd,
        port: btn.dataset.port, interactive: true
      }).catch(err => {
        toast(err.message, "error");
        btn.disabled    = false;
        btn.textContent = "Start";
      });
      return;
    }

    await withBtn(btn, async () => {
      switch (act) {
        case "attach":
          openAttachTab(name, btn.dataset.interactive === "1");
          break;

        case "shell":
          openShellTab(btn.dataset.cwd || ".", name);
          break;

        case "restart":
          await call("POST", `/api/processes/${enc(name)}/restart`);
          toast(`Restarted ${name}`, "success");
          break;

        case "stop":
          await call("POST", `/api/processes/${enc(name)}/stop`);
          toast(`Stopped ${name}`, "info");
          break;

        case "delete":
          await call("DELETE", `/api/processes/${enc(name)}`);
          toast(`Deleted ${name}`, "info");
          break;
      }
    });
  });

  // ── CF badge click → open tunnel log tab ─────────────────────────────────
  cfBadge.addEventListener("click", () => { if (cfLogOpened) openCfLogTab(); });

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

  function openAttachTab(name, interactive = false) {
    const id = `tab-attach-${name}`;
    if (tabs.has(id)) { activateTab(id); showPanel(); return; }
    const pane = document.createElement("div");
    pane.className = "tab-pane shell-pane";
    const tab = { id, type: "attach", title: name, name, interactive, pane, term: null, fitAddon: null, ws: null };
    tabs.set(id, tab);
    tabContent.appendChild(pane);
    activateTab(id);
    showPanel();
    spawnAttachTerminal(tab);
  }

  function spawnAttachTerminal(tab) {
    const term = new Terminal({
      cursorBlink:     tab.interactive,
      disableStdin:    !tab.interactive,
      fontSize:        13,
      fontFamily:      '"JetBrains Mono","SFMono-Regular",Consolas,monospace',
      theme:           TERM_THEME,
      scrollback:      5000,
      convertEol:      !tab.interactive,
      macOptionIsMeta: true
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    tab.term     = term;
    tab.fitAddon = fitAddon;

    renderTabBar();

    requestAnimationFrame(() => {
      if (!tabs.has(tab.id)) return;

      term.open(tab.pane);
      fitAddon.fit();

      const ro = new ResizeObserver(() => {
        if (activeTabId === tab.id) fitAddon.fit();
      });
      ro.observe(tab.pane);

      // Click anywhere in the pane to restore focus
      tab.pane.addEventListener("click", () => term.focus());

      const proto  = location.protocol === "https:" ? "wss:" : "ws:";
      const wsPath = tab.interactive ? "/api/attach" : "/api/logstream";

      // Register input handlers ONCE here, outside the reconnect loop.
      // tab.ws is kept current by connectWs() so the closures always
      // write to the live WebSocket.
      if (tab.interactive) {
        term.onData(data => {
          if (tab.ws && tab.ws.readyState === WebSocket.OPEN)
            tab.ws.send(JSON.stringify({ t: "i", d: data }));
        });
        term.onResize(({ cols, rows }) => {
          if (tab.ws && tab.ws.readyState === WebSocket.OPEN)
            tab.ws.send(JSON.stringify({ t: "resize", cols, rows }));
        });
        term.focus();
      }

      function connectWs() {
        if (!tabs.has(tab.id)) return;
        const params = new URLSearchParams({ name: tab.name, token: termToken || "" });
        const ws     = new WebSocket(`${proto}//${location.host}${wsPath}?${params}`);
        ws.binaryType = "arraybuffer";
        tab.ws = ws;

        // Set when server says process not found — suppress error, retry quietly.
        let pendingStart = false;

        ws.onopen = () => {
          if (tab.interactive) {
            ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
            term.focus();
          }
        };

        ws.onmessage = e => {
          if (e.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(e.data));
          } else {
            try {
              const msg = JSON.parse(e.data);
              if (msg.t === "error") {
                if (tab.interactive && /not found/i.test(msg.msg || "")) {
                  pendingStart = true; // process hasn't started yet, will retry
                } else {
                  term.write(`\r\n\x1b[31mError: ${msg.msg}\x1b[0m\r\n`);
                }
              }
            } catch { }
          }
        };

        ws.onclose = () => {
          if (!tabs.has(tab.id)) return;
          if (!tab.interactive) {
            // Logstream: always reconnect
            setTimeout(() => connectWs(), 1500);
          } else if (pendingStart) {
            // Interactive, process not started yet: show once then retry
            if (!tab._shownWaiting) {
              tab._shownWaiting = true;
              term.write("\x1b[90mPreparing process…\x1b[0m\r\n");
            }
            setTimeout(() => connectWs(), 1500);
          } else {
            // Interactive, was attached and process stopped/detached
            term.write("\r\n\x1b[90m── detached ──\x1b[0m\r\n");
          }
        };

        ws.onerror = () => {}; // onclose fires after onerror
      }

      connectWs();
    });
  }

  function activateTab(id) {
    if (!tabs.has(id)) return;
    activeTabId = id;
    for (const [tid, t] of tabs) {
      t.pane.classList.toggle("active", tid === id);
    }
    renderTabBar();
    const tab = tabs.get(id);
    if (tab && (tab.type === "shell" || tab.type === "attach") && tab.fitAddon) {
      requestAnimationFrame(() => tab.fitAddon.fit());
    }
  }

  function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    if (tab.ws)   { try { tab.ws.close();   } catch { } }
    if (tab.term) { try { tab.term.dispose(); } catch { } }
    tab.pane.remove();
    tabs.delete(id);
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
      const isCfLog  = tab.type === "cflog";
      const isAttach = tab.type === "attach";
      const icon     = isHealth ? "⚙" : isCfLog ? "☁" : isLog ? "≡" : isAttach ? "⬡" : "$";
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
        closeTab(el.dataset.closeTab);
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
      cursorBlink:     true,
      fontSize:        13,
      fontFamily:      '"JetBrains Mono","SFMono-Regular",Consolas,monospace',
      theme:           TERM_THEME,
      scrollback:      5000,
      macOptionIsMeta: true
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    tab.term     = term;
    tab.fitAddon = fitAddon;

    tabs.get(tab.id).title = `Shell: ${tab.cwd === "." ? "/" : tab.cwd}`;
    renderTabBar();

    requestAnimationFrame(() => {
      if (!tabs.has(tab.id)) return; // tab closed before RAF fired

      term.open(tab.pane);
      fitAddon.fit();

      const ro = new ResizeObserver(() => {
        if (activeTabId === tab.id) fitAddon.fit();
      });
      ro.observe(tab.pane);

      // Click anywhere in the pane to restore focus
      tab.pane.addEventListener("click", () => term.focus());

      const proto  = location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams({ cwd: tab.cwd, token: termToken || "" });
      const ws     = new WebSocket(`${proto}//${location.host}/api/terminal?${params}`);
      ws.binaryType = "arraybuffer";
      tab.ws = ws;

      term.write("\x1b[90mConnecting…\x1b[0m\r\n");

      ws.onopen = () => {
        term.write("\x1b[2K\x1b[1A\x1b[2K"); // clear connecting line
        ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        term.focus(); // re-assert focus once the shell is ready
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

      ws.onclose = () => { term.write("\r\n\x1b[90m── connection closed ──\x1b[0m\r\n"); };
      ws.onerror = () => { term.write("\r\n\x1b[31m── WebSocket error ──\x1b[0m\r\n"); };

      term.onData(data => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d: data }));
      });

      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols, rows }));
      });

      term.focus();
    });
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

  function fmtUptime(ms) {
    if (!ms) return "—";
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 0)     return "—";
    if (s < 60)    return s + "s";
    if (s < 3600)  return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }

  function fmtRate(bps) {
    if (!bps || bps < 10) return "0 B/s";
    const u = ["B/s","KB/s","MB/s"];
    let i = 0, v = bps;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  }
})();
