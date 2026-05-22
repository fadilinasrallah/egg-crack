"use strict";

const express    = require("express");
const { marked } = require("marked");

const app  = express();
const port = Number(process.env.PORT || 4002);

marked.setOptions({ gfm: true, breaks: true });

const INITIAL = `# Markdown Preview

Type in the left pane, see rendered HTML on the right.

## What's supported

- **Bold**, *italic*, ~~strikethrough~~
- \`inline code\` and fenced code blocks
- [Links](https://example.com) and images
- Ordered and unordered lists
- Tables and blockquotes
- GitHub-flavoured Markdown (GFM)

## Code block

\`\`\`javascript
async function fetchData(url) {
  const res = await fetch(url);
  return res.json();
}
\`\`\`

## Table

| Name     | Type    | Required |
|----------|---------|----------|
| name     | string  | yes      |
| category | string  | yes      |
| price    | number  | no       |

> **Tip:** Changes render instantly as you type.
`;

app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Markdown Preview</title>
  <style>
    :root { color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3;
           display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

    header { display: flex; align-items: center; gap: 10px; padding: 11px 20px;
             background: #161b22; border-bottom: 1px solid #30363d; flex-shrink: 0; }
    .brand { font-weight: 700; font-size: 15px; color: #58a6ff; }
    .info  { font-size: 12px; color: #8b949e; margin-left: auto; }

    .panes { display: grid; grid-template-columns: 1fr 1fr; flex: 1; overflow: hidden; }

    textarea {
      background: #0d1117; color: #e6edf3; border: none;
      border-right: 1px solid #30363d; padding: 20px;
      font: 13px/1.65 "SFMono-Regular", Consolas, monospace;
      resize: none; outline: none; height: 100%;
    }

    #preview {
      padding: 24px 28px; overflow-y: auto; line-height: 1.75;
      background: #0d1117; font-size: 14px;
    }

    /* Rendered markdown styles */
    #preview h1, #preview h2, #preview h3, #preview h4 {
      border-bottom: 1px solid #21262d; padding-bottom: 6px; margin: 22px 0 10px;
    }
    #preview h1 { font-size: 1.9em; } #preview h2 { font-size: 1.5em; }
    #preview h3 { font-size: 1.2em; border: none; }
    #preview p  { margin: 10px 0; }
    #preview a  { color: #58a6ff; }
    #preview code {
      background: #161b22; padding: 2px 6px; border-radius: 4px;
      font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.88em;
    }
    #preview pre {
      background: #161b22; padding: 16px; border-radius: 7px;
      overflow-x: auto; margin: 14px 0;
      border: 1px solid #21262d;
    }
    #preview pre code { background: none; padding: 0; border-radius: 0; }
    #preview blockquote {
      border-left: 3px solid #30363d; padding-left: 16px;
      color: #8b949e; margin: 12px 0;
    }
    #preview ul, #preview ol { padding-left: 28px; margin: 8px 0; }
    #preview li { margin: 3px 0; }
    #preview table { border-collapse: collapse; width: 100%; margin: 14px 0; }
    #preview th, #preview td {
      border: 1px solid #30363d; padding: 6px 12px; text-align: left;
    }
    #preview th { background: #161b22; font-weight: 600; }
    #preview tr:nth-child(even) td { background: rgba(255,255,255,0.02); }
    #preview img { max-width: 100%; border-radius: 6px; }
    #preview hr { border: none; border-top: 1px solid #30363d; margin: 18px 0; }
    #preview del { color: #8b949e; }
  </style>
</head>
<body>
  <header>
    <span class="brand">◈ Markdown Preview</span>
    <span class="info" id="info">0 words</span>
  </header>
  <div class="panes">
    <textarea id="editor" spellcheck="false" placeholder="Type Markdown here…">${
      INITIAL.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    }</textarea>
    <div id="preview"></div>
  </div>
  <script>
    const editor  = document.getElementById("editor");
    const preview = document.getElementById("preview");
    const info    = document.getElementById("info");

    let timer;

    async function render() {
      const md = editor.value;
      const words = md.trim() ? md.trim().split(/\\s+/).length : 0;
      info.textContent = words + " word" + (words === 1 ? "" : "s");
      const res  = await fetch("/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ md })
      });
      const { html } = await res.json();
      preview.innerHTML = html;
    }

    editor.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(render, 120);
    });

    render();
  </script>
</body>
</html>`);
});

app.post("/render", express.json(), (req, res) => {
  const md = String(req.body.md || "");
  res.json({ html: marked(md), chars: md.length });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.listen(port, () => console.log(`[markdown-preview] http://0.0.0.0:${port}`));
