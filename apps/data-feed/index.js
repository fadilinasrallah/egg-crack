"use strict";

const axios   = require("axios");
const express = require("express");

const app  = express();
const port = Number(process.env.PORT || 4003);

// ── Feed definitions ──────────────────────────────────
const FEEDS = [
  {
    id:       "posts",
    label:    "Blog Posts",
    url:      "https://jsonplaceholder.typicode.com/posts",
    params:   { _limit: 10 },
    interval: 60_000
  },
  {
    id:       "users",
    label:    "Users",
    url:      "https://jsonplaceholder.typicode.com/users",
    params:   { _limit: 10 },
    interval: 120_000
  },
  {
    id:       "todos",
    label:    "To-Dos",
    url:      "https://jsonplaceholder.typicode.com/todos",
    params:   { _limit: 20 },
    interval: 30_000
  }
];

// ── Cache ─────────────────────────────────────────────
const cache = {};
for (const f of FEEDS) {
  cache[f.id] = { data: null, fetchedAt: null, error: null, fetching: false };
}

async function fetchFeed(feed) {
  const c = cache[feed.id];
  if (c.fetching) return;
  c.fetching = true;
  try {
    const { data } = await axios.get(feed.url, { params: feed.params, timeout: 10_000 });
    c.data      = data;
    c.fetchedAt = new Date().toISOString();
    c.error     = null;
    console.log(`[data-feed] ${feed.id}: fetched ${Array.isArray(data) ? data.length : 1} item(s)`);
  } catch (err) {
    c.error = err.message;
    console.error(`[data-feed] ${feed.id}: ${err.message}`);
  } finally {
    c.fetching = false;
  }
}

function startTimers() {
  for (const feed of FEEDS) {
    fetchFeed(feed);
    setInterval(() => fetchFeed(feed), feed.interval).unref();
  }
}

// ── Routes ────────────────────────────────────────────
app.get("/", (_req, res) => {
  const summary = FEEDS.map(f => {
    const c = cache[f.id];
    return {
      id:        f.id,
      label:     f.label,
      url:       `/feed/${f.id}`,
      fetchedAt: c.fetchedAt,
      count:     Array.isArray(c.data) ? c.data.length : (c.data ? 1 : 0),
      error:     c.error,
      fetching:  c.fetching,
      refreshEvery: `${f.interval / 1000}s`
    };
  });
  res.json({ name: "data-feed", feeds: summary });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/feed/:id", (req, res) => {
  const feed = FEEDS.find(f => f.id === req.params.id);
  if (!feed) return res.status(404).json({ error: "Unknown feed." });

  const c = cache[feed.id];
  if (!c.data && !c.error) {
    return res.status(503).json({ error: "Feed not yet loaded, try again shortly." });
  }
  if (c.error && !c.data) {
    return res.status(502).json({ error: c.error });
  }

  // Optional filtering for posts/todos
  let data = c.data;
  if (req.query.q && Array.isArray(data)) {
    const q = req.query.q.toLowerCase();
    data = data.filter(item => JSON.stringify(item).toLowerCase().includes(q));
  }

  res.json({
    feed:      feed.id,
    label:     feed.label,
    fetchedAt: c.fetchedAt,
    count:     Array.isArray(data) ? data.length : 1,
    data
  });
});

app.post("/feed/:id/refresh", (req, res) => {
  const feed = FEEDS.find(f => f.id === req.params.id);
  if (!feed) return res.status(404).json({ error: "Unknown feed." });
  fetchFeed(feed);
  res.json({ ok: true, message: `Refresh started for "${feed.id}".` });
});

app.listen(port, () => {
  console.log(`[data-feed] http://0.0.0.0:${port}`);
  startTimers();
});
