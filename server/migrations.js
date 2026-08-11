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
  {
    version: 9,
    name: "order_item_quantity_unit",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(order_items)").all().map((column) => column.name));
      if (!columns.has("quantity_unit")) db.exec("ALTER TABLE order_items ADD COLUMN quantity_unit TEXT");
      db.exec("UPDATE order_items SET quantity_unit = CASE WHEN quantity = CAST(quantity AS INTEGER) THEN 'pack' ELSE 'mal' END WHERE quantity_unit IS NULL OR quantity_unit = '';");
      db.exec("UPDATE order_items SET quantity_unit = 'pack' WHERE quantity_unit IS NULL OR TRIM(quantity_unit) = '';");
      db.exec("UPDATE order_items SET quantity_unit = CASE WHEN quantity = CAST(quantity AS INTEGER) THEN 'pack' ELSE 'mal' END WHERE quantity_unit NOT IN ('pack', 'mal');");
    },
  },
  {
    version: 10,
    name: "repair_pending_mal_order_prices",
    up(db) {
      db.exec(`
        UPDATE order_items
        SET unit_price = (
              SELECT ROUND(products.price * 32)
              FROM products
              WHERE products.id = order_items.product_id
            ),
            line_total = ROUND(quantity * (
              SELECT products.price * 32
              FROM products
              WHERE products.id = order_items.product_id
            ))
        WHERE quantity_unit = 'mal'
          AND product_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM products
            WHERE products.id = order_items.product_id
              AND order_items.unit_price = products.price
          )
          AND order_id IN (
            SELECT orders.id FROM orders
            LEFT JOIN payments ON payments.order_id = orders.id
            WHERE payments.status IS NULL OR payments.status IN ('PENDING', 'FAILED')
          );

        UPDATE orders
        SET subtotal = (SELECT COALESCE(SUM(line_total), 0) FROM order_items WHERE order_items.order_id = orders.id),
            total_amount = (SELECT COALESCE(SUM(line_total), 0) FROM order_items WHERE order_items.order_id = orders.id) + delivery_fee,
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (
          SELECT DISTINCT order_id FROM order_items WHERE quantity_unit = 'mal'
        )
          AND id IN (
            SELECT orders.id FROM orders
            LEFT JOIN payments ON payments.order_id = orders.id
            WHERE payments.status IS NULL OR payments.status IN ('PENDING', 'FAILED')
          );

        UPDATE payments
        SET amount = (SELECT total_amount FROM orders WHERE orders.id = payments.order_id)
        WHERE status IN ('PENDING', 'FAILED')
          AND EXISTS (SELECT 1 FROM orders WHERE orders.id = payments.order_id);
      `);
    },
  },
  {
    version: 11,
    name: "admin_accounts_rbac",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS admin_accounts (
          user_id TEXT PRIMARY KEY,
          role TEXT NOT NULL CHECK (role IN ('super_admin','operations','finance','viewer')),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
          token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0),
          last_login_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_admin_accounts_active_role
          ON admin_accounts(is_active, role);
      `);
    },
  },
  {
    version: 12,
    name: "naver_product_mappings",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales_channel_product_mappings (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL DEFAULT 'naver' CHECK (channel = 'naver'),
          internal_product_id TEXT NOT NULL,
          external_origin_product_no TEXT NOT NULL CHECK (external_origin_product_no GLOB '[0-9]*' AND external_origin_product_no NOT GLOB '*[^0-9]*'),
          external_channel_product_no TEXT NOT NULL CHECK (external_channel_product_no GLOB '[0-9]*' AND external_channel_product_no NOT GLOB '*[^0-9]*'),
          external_group_product_no TEXT CHECK (external_group_product_no IS NULL OR (external_group_product_no GLOB '[0-9]*' AND external_group_product_no NOT GLOB '*[^0-9]*')),
          external_option_id TEXT CHECK (external_option_id IS NULL OR (external_option_id GLOB '[0-9]*' AND external_option_id NOT GLOB '*[^0-9]*')),
          seller_management_code TEXT,
          channel_service_type TEXT NOT NULL,
          external_product_name TEXT NOT NULL,
          external_status TEXT NOT NULL,
          mapping_status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
            CHECK (mapping_status IN ('ACTIVE','DISABLED','PENDING_VERIFICATION','UNSUPPORTED_OPTION','INVALID_INTERNAL_PRODUCT','EXTERNAL_NOT_FOUND','CONFLICT')),
          inventory_sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (inventory_sync_enabled IN (0,1)),
          price_sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (price_sync_enabled IN (0,1)),
          safety_stock INTEGER NOT NULL DEFAULT 0 CHECK (safety_stock >= 0 AND typeof(safety_stock) = 'integer'),
          last_verified_at TEXT,
          last_product_sync_at TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (internal_product_id) REFERENCES products(id) ON DELETE RESTRICT,
          UNIQUE (channel, internal_product_id),
          UNIQUE (channel, external_channel_product_no)
        );
        CREATE INDEX IF NOT EXISTS idx_sales_channel_product_mappings_status
          ON sales_channel_product_mappings(channel, mapping_status, updated_at);
      `);
    },
  },
  {
    version: 13,
    name: "naver_order_read_imports",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales_channel_order_imports (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL CHECK (channel = 'naver'),
          external_order_id TEXT NOT NULL,
          import_status TEXT NOT NULL CHECK (import_status IN (
            'DISCOVERED','IMPORTED','PARTIAL','RETRY_PENDING','FAILED','MANUAL_REVIEW'
          )),
          external_payment_status TEXT,
          payment_method TEXT,
          order_amount INTEGER CHECK (order_amount IS NULL OR order_amount >= 0),
          payment_amount INTEGER CHECK (payment_amount IS NULL OR payment_amount >= 0),
          ordered_at TEXT,
          paid_at TEXT,
          orderer_name_masked TEXT,
          orderer_phone_masked TEXT,
          order_pii_ciphertext TEXT,
          order_pii_iv TEXT,
          order_pii_auth_tag TEXT,
          order_pii_key_version TEXT,
          source_changed_at TEXT,
          last_synced_at TEXT,
          payload_hash TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (channel, external_order_id),
          CHECK (
            (order_pii_ciphertext IS NULL AND order_pii_iv IS NULL AND order_pii_auth_tag IS NULL AND order_pii_key_version IS NULL)
            OR
            (order_pii_ciphertext IS NOT NULL AND order_pii_iv IS NOT NULL AND order_pii_auth_tag IS NOT NULL AND order_pii_key_version IS NOT NULL)
          )
        );

        CREATE TABLE IF NOT EXISTS sales_channel_order_import_items (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL CHECK (channel = 'naver'),
          channel_order_import_id TEXT NOT NULL,
          external_product_order_id TEXT NOT NULL,
          external_channel_product_no TEXT,
          external_origin_product_no TEXT,
          external_claim_id TEXT,
          external_group_product_id TEXT,
          external_package_number TEXT,
          external_item_no TEXT,
          external_option_manage_code TEXT,
          product_mapping_id TEXT,
          internal_product_id TEXT,
          product_name_snapshot TEXT,
          option_name_snapshot TEXT,
          seller_product_code TEXT,
          initial_quantity INTEGER CHECK (initial_quantity IS NULL OR initial_quantity >= 0),
          remaining_quantity INTEGER CHECK (remaining_quantity IS NULL OR remaining_quantity >= 0),
          unit_price INTEGER CHECK (unit_price IS NULL OR unit_price >= 0),
          initial_payment_amount INTEGER CHECK (initial_payment_amount IS NULL OR initial_payment_amount >= 0),
          remaining_payment_amount INTEGER CHECK (remaining_payment_amount IS NULL OR remaining_payment_amount >= 0),
          external_product_order_status TEXT,
          external_claim_type TEXT,
          external_claim_status TEXT,
          last_changed_type TEXT,
          source_changed_at TEXT,
          recipient_name_masked TEXT,
          recipient_phone_masked TEXT,
          item_pii_ciphertext TEXT,
          item_pii_iv TEXT,
          item_pii_auth_tag TEXT,
          item_pii_key_version TEXT,
          mapping_status TEXT NOT NULL CHECK (mapping_status IN ('MAPPED','UNMAPPED')),
          payload_hash TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (channel, external_product_order_id),
          FOREIGN KEY (channel_order_import_id) REFERENCES sales_channel_order_imports(id) ON DELETE CASCADE,
          FOREIGN KEY (product_mapping_id) REFERENCES sales_channel_product_mappings(id) ON DELETE SET NULL,
          FOREIGN KEY (internal_product_id) REFERENCES products(id) ON DELETE SET NULL,
          CHECK (
            (item_pii_ciphertext IS NULL AND item_pii_iv IS NULL AND item_pii_auth_tag IS NULL AND item_pii_key_version IS NULL)
            OR
            (item_pii_ciphertext IS NOT NULL AND item_pii_iv IS NOT NULL AND item_pii_auth_tag IS NOT NULL AND item_pii_key_version IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS idx_sales_channel_order_imports_status_changed
          ON sales_channel_order_imports(channel, import_status, source_changed_at);
        CREATE INDEX IF NOT EXISTS idx_sales_channel_order_import_items_header
          ON sales_channel_order_import_items(channel_order_import_id);
        CREATE INDEX IF NOT EXISTS idx_sales_channel_order_import_items_mapping
          ON sales_channel_order_import_items(mapping_status, external_product_order_status);
      `);
    },
  },
  {
    version: 14,
    name: "naver_order_import_orchestration",
    up(db) {
      db.exec(`
        CREATE TABLE sales_channel_sync_cursors (
          channel TEXT NOT NULL CHECK (channel = 'naver'),
          stream TEXT NOT NULL CHECK (stream = 'order-import'),
          initial_from TEXT,
          window_from TEXT,
          window_to TEXT,
          more_from TEXT,
          more_sequence TEXT CHECK (more_sequence IS NULL OR (
            more_sequence <> '' AND more_sequence NOT GLOB '*[^0-9]*'
          )),
          committed_through TEXT,
          lease_run_id TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (channel, stream),
          CHECK ((lease_run_id IS NULL AND lease_expires_at IS NULL)
            OR (lease_run_id IS NOT NULL AND lease_expires_at IS NOT NULL))
        );

        CREATE TABLE sales_channel_sync_runs (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL CHECK (channel = 'naver'),
          sync_type TEXT NOT NULL CHECK (sync_type IN ('PULL','REFRESH')),
          target_import_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED','ABORTED')),
          requested_from TEXT,
          requested_to TEXT,
          pages_fetched INTEGER NOT NULL DEFAULT 0 CHECK (pages_fetched >= 0),
          discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
          detailed_count INTEGER NOT NULL DEFAULT 0 CHECK (detailed_count >= 0),
          imported_count INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
          failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
          provider_trace_id TEXT,
          safe_error_code TEXT,
          lock_expires_at TEXT CHECK (lock_expires_at IS NULL OR (
            lock_expires_at GLOB '????-??-??T??:??:??*'
            AND julianday(lock_expires_at) IS NOT NULL
            AND (substr(lock_expires_at, -1) = 'Z'
              OR substr(lock_expires_at, -6, 1) IN ('+','-'))
          )),
          actor TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((sync_type = 'PULL' AND target_import_id IS NULL)
            OR (sync_type = 'REFRESH' AND target_import_id IS NOT NULL)),
          CHECK ((status = 'RUNNING' AND completed_at IS NULL AND lock_expires_at IS NOT NULL)
            OR (status <> 'RUNNING' AND completed_at IS NOT NULL AND lock_expires_at IS NULL))
        );

        CREATE TABLE sales_channel_sync_run_failures (
          id TEXT PRIMARY KEY,
          sync_run_id TEXT NOT NULL,
          external_product_order_id TEXT,
          stage TEXT NOT NULL CHECK (stage IN (
            'CHANGE_FEED','DETAIL_FETCH','NORMALIZATION','PERSISTENCE','REFRESH'
          )),
          safe_error_code TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (sync_run_id) REFERENCES sales_channel_sync_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_sales_channel_sync_cursors_channel_stream
          ON sales_channel_sync_cursors(channel, stream);
        CREATE INDEX idx_sales_channel_sync_runs_channel_status_started
          ON sales_channel_sync_runs(channel, status, started_at);
        CREATE UNIQUE INDEX idx_sales_channel_sync_runs_active_refresh
          ON sales_channel_sync_runs(channel, target_import_id)
          WHERE sync_type='REFRESH' AND status='RUNNING';
        CREATE INDEX idx_sales_channel_sync_failures_run_stage
          ON sales_channel_sync_run_failures(sync_run_id, stage);
        CREATE INDEX idx_sales_channel_sync_failures_product_order
          ON sales_channel_sync_run_failures(external_product_order_id);
      `);
    },
  },
  {
    version: 15,
    name: "order_pii_protection_foundation",
    up(db) {
      const columns = new Set(
        db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name),
      );
      const additions = [
        ["pii_ciphertext", "TEXT"],
        ["pii_iv", "TEXT"],
        ["pii_auth_tag", "TEXT"],
        ["pii_key_version", "TEXT"],
        ["customer_name_masked", "TEXT"],
        ["customer_phone_masked", "TEXT"],
        ["delivery_region_masked", "TEXT"],
        ["pii_migrated_at", "TEXT"],
      ];
      for (const [name, type] of additions) {
        if (!columns.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_orders_pii_tuple_insert
        BEFORE INSERT ON orders
        WHEN NOT (
          (NEW.pii_ciphertext IS NULL AND NEW.pii_iv IS NULL
            AND NEW.pii_auth_tag IS NULL AND NEW.pii_key_version IS NULL)
          OR
          (NEW.pii_ciphertext IS NOT NULL AND NEW.pii_iv IS NOT NULL
            AND NEW.pii_auth_tag IS NOT NULL AND NEW.pii_key_version IS NOT NULL)
        )
        BEGIN
          SELECT RAISE(ABORT, 'ORDER_PII_TUPLE_INVALID');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_orders_pii_tuple_update
        BEFORE UPDATE OF pii_ciphertext, pii_iv, pii_auth_tag, pii_key_version ON orders
        WHEN NOT (
          (NEW.pii_ciphertext IS NULL AND NEW.pii_iv IS NULL
            AND NEW.pii_auth_tag IS NULL AND NEW.pii_key_version IS NULL)
          OR
          (NEW.pii_ciphertext IS NOT NULL AND NEW.pii_iv IS NOT NULL
            AND NEW.pii_auth_tag IS NOT NULL AND NEW.pii_key_version IS NOT NULL)
        )
        BEGIN
          SELECT RAISE(ABORT, 'ORDER_PII_TUPLE_INVALID');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_orders_pii_metadata_insert
        BEFORE INSERT ON orders
        WHEN length(COALESCE(NEW.pii_key_version, '')) > 100
          OR length(COALESCE(NEW.customer_name_masked, '')) > 200
          OR length(COALESCE(NEW.customer_phone_masked, '')) > 100
          OR length(COALESCE(NEW.delivery_region_masked, '')) > 300
        BEGIN
          SELECT RAISE(ABORT, 'ORDER_PII_METADATA_INVALID');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_orders_pii_metadata_update
        BEFORE UPDATE OF pii_key_version, customer_name_masked,
          customer_phone_masked, delivery_region_masked ON orders
        WHEN length(COALESCE(NEW.pii_key_version, '')) > 100
          OR length(COALESCE(NEW.customer_name_masked, '')) > 200
          OR length(COALESCE(NEW.customer_phone_masked, '')) > 100
          OR length(COALESCE(NEW.delivery_region_masked, '')) > 300
        BEGIN
          SELECT RAISE(ABORT, 'ORDER_PII_METADATA_INVALID');
        END;
      `);
    },
  },
  {
    version: 16,
    name: "structured_order_pii_access_audit",
    up(db) {
      const columns = new Set(
        db.prepare("PRAGMA table_info(activity_logs)").all().map((column) => column.name),
      );
      const additions = [
        ["reason", "TEXT"],
        ["outcome", "TEXT"],
        ["failure_code", "TEXT"],
        ["actor_role", "TEXT"],
        ["request_ip", "TEXT"],
      ];
      for (const [name, type] of additions) {
        if (!columns.has(name)) db.exec(`ALTER TABLE activity_logs ADD COLUMN ${name} ${type}`);
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_activity_logs_pii_audit_insert
        BEFORE INSERT ON activity_logs
        WHEN length(COALESCE(NEW.reason, '')) > 50
          OR (NEW.outcome IS NOT NULL AND NEW.outcome NOT IN ('success', 'failure'))
          OR length(COALESCE(NEW.failure_code, '')) > 100
          OR length(COALESCE(NEW.actor_role, '')) > 50
          OR length(COALESCE(NEW.request_ip, '')) > 100
        BEGIN
          SELECT RAISE(ABORT, 'ACTIVITY_LOG_STRUCTURED_AUDIT_INVALID');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_activity_logs_pii_audit_update
        BEFORE UPDATE OF reason, outcome, failure_code, actor_role, request_ip
        ON activity_logs
        WHEN length(COALESCE(NEW.reason, '')) > 50
          OR (NEW.outcome IS NOT NULL AND NEW.outcome NOT IN ('success', 'failure'))
          OR length(COALESCE(NEW.failure_code, '')) > 100
          OR length(COALESCE(NEW.actor_role, '')) > 50
          OR length(COALESCE(NEW.request_ip, '')) > 100
        BEGIN
          SELECT RAISE(ABORT, 'ACTIVITY_LOG_STRUCTURED_AUDIT_INVALID');
        END;

        CREATE INDEX IF NOT EXISTS idx_activity_logs_action_entity_created
          ON activity_logs(action, entity_id, created_at);
      `);
    },
  },
  {
    version: 17,
    name: "product_detail_images",
    up(db) {
      const columns = new Set(
        db.prepare("PRAGMA table_info(products)").all().map((column) => column.name),
      );
      if (!columns.has("detail_images_json")) {
        db.exec("ALTER TABLE products ADD COLUMN detail_images_json TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    version: 18,
    name: "product_unit_prices_and_origins",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(products)").all().map((column) => column.name));
      if (!columns.has("half_mal_price")) db.exec("ALTER TABLE products ADD COLUMN half_mal_price INTEGER");
      if (!columns.has("mal_price")) db.exec("ALTER TABLE products ADD COLUMN mal_price INTEGER");
      if (!columns.has("origin_items_json")) db.exec("ALTER TABLE products ADD COLUMN origin_items_json TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 19,
    name: "white_jeolpyeon_origin_sample",
    up(db) {
      db.prepare(`UPDATE products
        SET origin_items_json = ?, updated_at = ?
        WHERE id = 'white-jeolpyeon'
          AND (origin_items_json IS NULL OR origin_items_json = '' OR origin_items_json = '[]')`)
        .run(JSON.stringify([
          { ingredient: "멥쌀", origin: "국내산" },
          { ingredient: "소금", origin: "국내산" },
          { ingredient: "설탕", origin: "외국산" },
          { ingredient: "참기름", origin: "국내산" },
        ]), new Date().toISOString());
    },
  },
  {
    version: 20,
    name: "product_unit_weight_and_assorted_chaltteok_copy",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(products)").all().map((column) => column.name));
      if (!columns.has("unit_weight_grams")) {
        db.exec("ALTER TABLE products ADD COLUMN unit_weight_grams INTEGER NOT NULL DEFAULT 250");
      }
      db.prepare(`UPDATE products
        SET unit_weight_grams = 230,
            description = ?,
            updated_at = ?
        WHERE id = 'assorted-chaltteok'`)
        .run("단호박과 밤, 팥, 검은콩을 넉넉히 넣어 만든 수제 모듬찰떡", new Date().toISOString());
    },
  },
  {
    version: 21,
    name: "product_detail_images_assorted_chaltteok_seed",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(products)").all().map((column) => column.name));
      if (!columns.has("detail_images_json")) {
        db.exec("ALTER TABLE products ADD COLUMN detail_images_json TEXT NOT NULL DEFAULT '[]'");
      }
      db.prepare(`UPDATE products
        SET detail_images_json = ?,
            updated_at = ?
        WHERE id = 'assorted-chaltteok'
          AND (detail_images_json IS NULL OR detail_images_json = '' OR detail_images_json = '[]')`)
        .run(JSON.stringify([
          "assets/products/04_warm_ricecake_storage_1200x800.webp",
          "assets/products/16cd5755-9a6f-411d-8cf8-1d93d9dff89a.png",
          "assets/products/2a1ee0a9-5fac-43aa-a889-6d59a77a0680.png",
          "assets/products/c843c321-397a-4ece-a628-3706fa4f7a3f.png",
        ]), new Date().toISOString());
    },
  },
  {
    version: 22,
    name: "product_detail_images_assorted_chaltteok_reorder",
    up(db) {
      db.prepare(`UPDATE products
        SET detail_images_json = ?,
            updated_at = ?
        WHERE id = 'assorted-chaltteok'`)
        .run(JSON.stringify([
          "assets/products/c843c321-397a-4ece-a628-3706fa4f7a3f.png",
          "assets/products/2a1ee0a9-5fac-43aa-a889-6d59a77a0680.png",
          "assets/products/16cd5755-9a6f-411d-8cf8-1d93d9dff89a.png",
          "assets/products/04_warm_ricecake_storage_1200x800.webp",
        ]), new Date().toISOString());
    },
  },
  {
    version: 23,
    name: "product_and_order_unit_weights",
    up(db) {
      const productColumns = new Set(db.prepare("PRAGMA table_info(products)").all().map((column) => column.name));
      if (!productColumns.has("half_mal_weight_grams")) db.exec("ALTER TABLE products ADD COLUMN half_mal_weight_grams INTEGER");
      if (!productColumns.has("mal_weight_grams")) db.exec("ALTER TABLE products ADD COLUMN mal_weight_grams INTEGER");

      const itemColumns = new Set(db.prepare("PRAGMA table_info(order_items)").all().map((column) => column.name));
      if (!itemColumns.has("pack_weight_grams")) db.exec("ALTER TABLE order_items ADD COLUMN pack_weight_grams INTEGER");
      if (!itemColumns.has("half_mal_weight_grams")) db.exec("ALTER TABLE order_items ADD COLUMN half_mal_weight_grams INTEGER");
      if (!itemColumns.has("mal_weight_grams")) db.exec("ALTER TABLE order_items ADD COLUMN mal_weight_grams INTEGER");
      if (!itemColumns.has("total_weight_grams")) db.exec("ALTER TABLE order_items ADD COLUMN total_weight_grams INTEGER");
    },
  },
  {
    version: 24,
    name: "naver_product_unit_mappings",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales_channel_product_unit_mappings (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL DEFAULT 'naver' CHECK (channel = 'naver'),
          internal_product_id TEXT NOT NULL,
          sales_unit TEXT NOT NULL CHECK (sales_unit IN ('pack','half_mal','mal')),
          external_origin_product_no TEXT NOT NULL CHECK (external_origin_product_no GLOB '[0-9]*' AND external_origin_product_no NOT GLOB '*[^0-9]*'),
          external_channel_product_no TEXT NOT NULL CHECK (external_channel_product_no GLOB '[0-9]*' AND external_channel_product_no NOT GLOB '*[^0-9]*'),
          external_product_name TEXT NOT NULL,
          external_status TEXT NOT NULL,
          mapping_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (mapping_status IN ('ACTIVE','DISABLED')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (internal_product_id) REFERENCES products(id) ON DELETE RESTRICT,
          UNIQUE (channel, internal_product_id, sales_unit),
          UNIQUE (channel, external_channel_product_no)
        );
        CREATE INDEX IF NOT EXISTS idx_sales_channel_product_unit_mappings_status
          ON sales_channel_product_unit_mappings(channel, mapping_status, updated_at);
      `);
      const itemColumns = new Set(db.prepare("PRAGMA table_info(sales_channel_order_import_items)").all().map((column) => column.name));
      if (!itemColumns.has("product_unit_mapping_id")) db.exec("ALTER TABLE sales_channel_order_import_items ADD COLUMN product_unit_mapping_id TEXT REFERENCES sales_channel_product_unit_mappings(id) ON DELETE SET NULL");
      if (!itemColumns.has("sales_unit_snapshot")) db.exec("ALTER TABLE sales_channel_order_import_items ADD COLUMN sales_unit_snapshot TEXT CHECK (sales_unit_snapshot IS NULL OR sales_unit_snapshot IN ('pack','half_mal','mal'))");
    },
  },
  {
    version: 25,
    name: "naver_order_internal_conversion",
    up(db) {
      const orderColumns = new Set(db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name));
      if (!orderColumns.has("source_channel")) db.exec("ALTER TABLE orders ADD COLUMN source_channel TEXT");
      if (!orderColumns.has("external_order_id")) db.exec("ALTER TABLE orders ADD COLUMN external_order_id TEXT");
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_source_external
          ON orders(source_channel, external_order_id)
          WHERE source_channel IS NOT NULL AND external_order_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS sales_channel_order_conversions (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL CHECK (channel = 'naver'),
          channel_order_import_id TEXT NOT NULL,
          external_order_id TEXT NOT NULL,
          internal_order_id TEXT,
          conversion_status TEXT NOT NULL CHECK (conversion_status IN ('CONVERTED','MANUAL_REVIEW','FAILED')),
          safe_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (channel, channel_order_import_id),
          UNIQUE (channel, external_order_id),
          FOREIGN KEY (channel_order_import_id) REFERENCES sales_channel_order_imports(id) ON DELETE RESTRICT,
          FOREIGN KEY (internal_order_id) REFERENCES orders(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_sales_channel_order_conversions_status
          ON sales_channel_order_conversions(channel, conversion_status, updated_at);
      `);
    },
  },
  {
    version: 26,
    name: "naver_order_status_synchronization",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales_channel_order_status_syncs (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL CHECK (channel = 'naver'),
          conversion_id TEXT NOT NULL,
          channel_order_import_id TEXT NOT NULL,
          internal_order_id TEXT NOT NULL,
          external_status TEXT,
          source_changed_at TEXT,
          internal_status TEXT NOT NULL,
          sync_status TEXT NOT NULL CHECK (sync_status IN ('SYNCHRONIZED','MANUAL_REVIEW')),
          safe_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (channel, conversion_id),
          FOREIGN KEY (conversion_id) REFERENCES sales_channel_order_conversions(id) ON DELETE RESTRICT,
          FOREIGN KEY (channel_order_import_id) REFERENCES sales_channel_order_imports(id) ON DELETE RESTRICT,
          FOREIGN KEY (internal_order_id) REFERENCES orders(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_sales_channel_order_status_syncs_review
          ON sales_channel_order_status_syncs(channel, sync_status, updated_at);
      `);
    },
  },
  {
    version: 27,
    name: "naver_shipment_dispatches",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales_channel_shipment_dispatches (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL CHECK (channel='naver'),
          internal_order_id TEXT NOT NULL,
          conversion_id TEXT NOT NULL,
          carrier_code TEXT NOT NULL,
          tracking_number TEXT NOT NULL,
          dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('PROCESSING','SUCCEEDED','FAILED','RECONCILE_REQUIRED')),
          attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
          safe_error_code TEXT,
          lock_token TEXT,
          requested_at TEXT NOT NULL,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE (channel, internal_order_id),
          FOREIGN KEY (internal_order_id) REFERENCES orders(id) ON DELETE RESTRICT,
          FOREIGN KEY (conversion_id) REFERENCES sales_channel_order_conversions(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_sales_channel_shipment_dispatches_status
          ON sales_channel_shipment_dispatches(channel,dispatch_status,updated_at);
      `);
    },
  },
  {
    version: 28,
    name: "naver_shipment_reconciliation",
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(sales_channel_shipment_dispatches)").all().map((column) => column.name));
      if (!columns.has("reconciliation_attempt_count")) {
        db.exec("ALTER TABLE sales_channel_shipment_dispatches ADD COLUMN reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_attempt_count >= 0)");
      }
      if (!columns.has("last_reconciled_at")) {
        db.exec("ALTER TABLE sales_channel_shipment_dispatches ADD COLUMN last_reconciled_at TEXT");
      }
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
