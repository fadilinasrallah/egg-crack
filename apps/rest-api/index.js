"use strict";

const express = require("express");
const cors    = require("cors");

const app  = express();
const port = Number(process.env.PORT || 4001);

// ── in-memory "database" ──────────────────────────────
let nextId = 1;
const items = [
  { id: nextId++, name: "Apple",  category: "fruit",  price: 0.99 },
  { id: nextId++, name: "Carrot", category: "veggie", price: 0.49 },
  { id: nextId++, name: "Bread",  category: "bakery", price: 2.50 }
];

// ── middleware ────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── routes ────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    name: "rest-api",
    description: "A simple CRUD REST API",
    endpoints: {
      "GET  /health":        "Health check",
      "GET  /items":         "List all items (supports ?category= filter)",
      "GET  /items/:id":     "Get one item",
      "POST /items":         "Create an item  { name, category, price }",
      "PUT  /items/:id":     "Replace an item",
      "PATCH /items/:id":    "Update fields",
      "DELETE /items/:id":   "Delete an item"
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
});

app.get("/items", (req, res) => {
  const { category, sort } = req.query;
  let list = category ? items.filter(i => i.category === category) : [...items];
  if (sort === "price") list.sort((a, b) => a.price - b.price);
  if (sort === "name")  list.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ count: list.length, items: list });
});

app.get("/items/:id", (req, res) => {
  const item = items.find(i => i.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: "Item not found." });
  res.json(item);
});

app.post("/items", (req, res) => {
  const { name, category, price } = req.body;
  if (!name || !category) return res.status(400).json({ error: "name and category are required." });
  const item = { id: nextId++, name: String(name), category: String(category), price: Number(price) || 0 };
  items.push(item);
  res.status(201).json(item);
});

app.put("/items/:id", (req, res) => {
  const idx = items.findIndex(i => i.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Item not found." });
  const { name, category, price } = req.body;
  if (!name || !category) return res.status(400).json({ error: "name and category are required." });
  items[idx] = { id: items[idx].id, name: String(name), category: String(category), price: Number(price) || 0 };
  res.json(items[idx]);
});

app.patch("/items/:id", (req, res) => {
  const item = items.find(i => i.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (req.body.name     !== undefined) item.name     = String(req.body.name);
  if (req.body.category !== undefined) item.category = String(req.body.category);
  if (req.body.price    !== undefined) item.price    = Number(req.body.price);
  res.json(item);
});

app.delete("/items/:id", (req, res) => {
  const idx = items.findIndex(i => i.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Item not found." });
  const [removed] = items.splice(idx, 1);
  res.json({ deleted: removed });
});

// ── 404 catch-all ────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found." }));

app.listen(port, () => console.log(`[rest-api] http://0.0.0.0:${port}`));
