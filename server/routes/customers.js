const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function rowToCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    type: row.type,
    memo: row.memo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/customers
router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM customers ORDER BY created_at DESC").all();
  res.json(rows.map(rowToCustomer));
});

// POST /api/customers
router.post("/", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const { id = `customer-${Date.now()}`, name, phone, type = "일반", memo } = req.body;
  if (!name) return res.status(400).json({ error: "고객명은 필수입니다." });

  db.prepare(`
    INSERT INTO customers (id, name, phone, type, memo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, phone ?? null, type, memo ?? null, now, now);

  const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
  res.status(201).json(rowToCustomer(row));
});

// PUT /api/customers/:id
router.put("/:id", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "고객을 찾을 수 없습니다." });

  const name = req.body.name ?? existing.name;
  if (!name) return res.status(400).json({ error: "고객명은 필수입니다." });

  db.prepare(`
    UPDATE customers SET name=?, phone=?, type=?, memo=?, updated_at=? WHERE id=?
  `).run(name, req.body.phone ?? existing.phone, req.body.type ?? existing.type, req.body.memo ?? existing.memo, now, req.params.id);

  const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  res.json(rowToCustomer(row));
});

// DELETE /api/customers/:id
router.delete("/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT id FROM customers WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "고객을 찾을 수 없습니다." });
  db.prepare("DELETE FROM customers WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// GET /api/customers/notes — 전체 메모 객체 반환
router.get("/notes", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM customer_notes").all();
  const notes = {};
  rows.forEach((row) => { notes[row.customer_key] = row.note; });
  res.json(notes);
});

// PUT /api/customers/notes/:key — 특정 고객 메모 저장
router.put("/notes/:key", requireAuth, (req, res) => {
  const { note = "" } = req.body;
  db.prepare(`
    INSERT INTO customer_notes (customer_key, note) VALUES (?, ?)
    ON CONFLICT(customer_key) DO UPDATE SET note=excluded.note
  `).run(req.params.key, note);
  res.json({ ok: true });
});

// DELETE /api/customers/notes/:key — 특정 고객 메모 삭제
router.delete("/notes/:key", requireAuth, (req, res) => {
  db.prepare("DELETE FROM customer_notes WHERE customer_key = ?").run(req.params.key);
  res.json({ ok: true });
});

module.exports = router;
