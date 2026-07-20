const migrations = [
  {
    version: 1,
    name: "baseline_schema",
    up() {
      // 기존 설치의 현재 스키마를 버전 관리 기준점으로 등록한다.
    },
  },
  {
    version: 2,
    name: "operational_indexes",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_phone_verifications_expires_at ON phone_verifications(expires_at);
        CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);
      `);
    },
  },
  {
    version: 3,
    name: "separate_order_payment_and_amount_status",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name));
      if (!columns.has("payment_status")) db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT '결제대기'");
      if (!columns.has("amount_status")) db.exec("ALTER TABLE orders ADD COLUMN amount_status TEXT NOT NULL DEFAULT 'confirmed'");
      db.exec(`
        UPDATE orders SET payment_status='결제완료', status='접수대기' WHERE status='결제완료';
        UPDATE orders SET payment_status='결제취소', status='취소' WHERE status='결제취소';
        UPDATE orders SET payment_status='결제완료'
          WHERE status IN ('픽업완료', '배송완료') AND payment_status='결제대기';
        UPDATE orders SET amount_status='pending'
          WHERE total_amount=0 AND status NOT IN ('취소', '주문취소');
        UPDATE orders SET payment_status='결제완료'
          WHERE id IN (SELECT order_id FROM payments WHERE status='DONE');
        UPDATE orders SET payment_status='결제취소'
          WHERE id IN (SELECT order_id FROM payments WHERE status='CANCELED');
        UPDATE orders SET pickup_date=date(substr(created_at, 1, 10), '+1 day')
          WHERE pickup_date IS NOT NULL AND pickup_date <> '' AND pickup_date < substr(created_at, 1, 10);
      `);
    },
  },
  {
    version: 4,
    name: "structured_activity_audit_logs",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(activity_logs)").all().map((column) => column.name));
      const additions = [
        ["action", "TEXT"], ["entity_id", "TEXT"], ["previous_value", "TEXT"],
        ["next_value", "TEXT"], ["actor", "TEXT NOT NULL DEFAULT '관리자'"],
      ];
      additions.forEach(([name, type]) => {
        if (!columns.has(name)) db.exec(`ALTER TABLE activity_logs ADD COLUMN ${name} ${type}`);
      });
      db.exec("CREATE INDEX IF NOT EXISTS idx_activity_logs_entity_created ON activity_logs(entity_id, created_at)");
    },
  },
  {
    version: 5,
    name: "order_status_change_reason",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(order_status_history)").all().map((column) => column.name));
      if (!columns.has("reason")) db.exec("ALTER TABLE order_status_history ADD COLUMN reason TEXT");
    },
  },
  {
    version: 6,
    name: "payment_partial_refunds",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(payments)").all().map((column) => column.name));
      const additions = [["canceled_amount", "INTEGER NOT NULL DEFAULT 0"], ["cancel_reason", "TEXT"], ["payment_method", "TEXT"]];
      additions.forEach(([name, type]) => { if (!columns.has(name)) db.exec(`ALTER TABLE payments ADD COLUMN ${name} ${type}`); });
    },
  },
  {
    version: 7,
    name: "unified_order_workflow_status",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name));
      if (!columns.has("workflow_status")) db.exec("ALTER TABLE orders ADD COLUMN workflow_status TEXT NOT NULL DEFAULT '결제대기'");
      db.exec(`
        UPDATE orders SET workflow_status = CASE
          WHEN status IN ('취소', '주문취소') OR payment_status IN ('결제취소', '환불완료') THEN '취소'
          WHEN status IN ('픽업완료', '배송완료') THEN '완료'
          WHEN status IN ('준비중', '준비완료', '배송중') THEN '접수완료'
          WHEN payment_status = '결제완료' THEN '결제완료'
          ELSE '결제대기' END;
      `);
    },
  },
  {
    version: 8,
    name: "five_step_order_workflow",
    up(db) {
      db.exec(`
        UPDATE orders SET workflow_status = CASE
          WHEN workflow_status = '결제완료' THEN '접수대기'
          WHEN workflow_status = '완료' AND fulfillment_type = 'delivery' THEN '배송완료'
          WHEN workflow_status = '완료' THEN '픽업완료'
          WHEN workflow_status = '접수완료' AND status = '배송중' THEN '배송중'
          WHEN workflow_status = '접수완료' AND status = '준비완료' AND fulfillment_type != 'delivery' THEN '픽업준비완료'
          ELSE workflow_status END;
      `);
    },
  },
];

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

module.exports = { migrations, runMigrations };
