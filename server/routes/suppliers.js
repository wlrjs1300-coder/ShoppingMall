const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function rowToSupplier(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.contact,   // DB 컬럼명은 contact, 프론트는 phone
    items: row.items,
    memo: row.memo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/suppliers
router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM suppliers ORDER BY created_at DESC").all();
  res.json(rows.map(rowToSupplier));
});

// POST /api/suppliers
router.post("/", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const { id = `supplier-${Date.now()}`, name, memo } = req.body;
  if (!name) return res.status(400).json({ error: "공급처명은 필수입니다." });

  const conflict = db.prepare("SELECT id FROM suppliers WHERE name = ? AND id != ?").get(name, id);
  if (conflict) return res.status(409).json({ error: `"${name}" 공급처가 이미 존재합니다.` });

  db.prepare(`
    INSERT INTO suppliers (id, name, contact, items, memo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, req.body.phone ?? null, req.body.items ?? null, memo ?? null, now, now);

  const row = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(id);
  res.status(201).json(rowToSupplier(row));
});

// PUT /api/suppliers/:id
router.put("/:id", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "공급처를 찾을 수 없습니다." });

  const name = req.body.name ?? existing.name;
  if (!name) return res.status(400).json({ error: "공급처명은 필수입니다." });

  const conflict = db.prepare("SELECT id FROM suppliers WHERE name = ? AND id != ?").get(name, req.params.id);
  if (conflict) return res.status(409).json({ error: `"${name}" 공급처가 이미 존재합니다.` });

  db.prepare(`
    UPDATE suppliers SET name=?, contact=?, items=?, memo=?, updated_at=? WHERE id=?
  `).run(name, req.body.phone ?? existing.contact, req.body.items ?? existing.items,
    req.body.memo ?? existing.memo, now, req.params.id);

  const row = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  res.json(rowToSupplier(row));
});

// DELETE /api/suppliers/:id
router.delete("/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT id FROM suppliers WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "공급처를 찾을 수 없습니다." });
  db.prepare("DELETE FROM suppliers WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
