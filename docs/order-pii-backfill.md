# Order PII backfill

This one-off CLI inventories and encrypts valid legacy `orders` rows. It does not
purge payment PII or change the runtime protection flag.

Run commands from the repository root:

```text
node server/scripts/backfill-order-pii.js --dry-run
node server/scripts/backfill-order-pii.js --apply --batch-size=100
node server/scripts/backfill-order-pii.js --verify
```

No mode means `--dry-run`. Only one mode is accepted. Supported controls are
`--batch-size=1..1000`, `--limit=<positive integer>`, `--after-id=<cursor>`,
and `--report=<path>`. Production apply additionally requires:

```text
--confirm=BACKFILL_ORDER_PII
```

Apply stops before mutation when a partial encryption tuple or unknown key
version exists. Invalid legacy rows require the operator to review the dry-run
report and explicitly add `--allow-invalid-skip`; those rows remain unchanged.

`ORDER_PII_KEYS_JSON` and `ORDER_PII_ACTIVE_KEY_VERSION` must be valid even when
`ORDER_PII_PROTECTION_ENABLED=false`. Output includes only counts, cursors,
classification codes, IDs, metadata booleans, and key version names. It never
includes PII, ciphertext, IVs, authentication tags, or key material.

The optional report is UTF-8 JSONL. A relative path resolves from the current
working directory. Its parent directory must already exist, and an existing
destination is never overwritten. The CLI writes an exclusive temporary file
in that directory and atomically renames it.

A process lock is created in the operating-system temporary directory by
default. `ORDER_PII_BACKFILL_LOCK_PATH` may point to an approved external
operations directory. Age alone never permits takeover: the lock must be valid
JSON, older than six hours, and its PID must be confirmed inactive. A current
PID, malformed lock, permission error, or uncertain platform result fails
closed as a conflict. Each lock has a random owner token that is never logged;
cleanup deletes the file only while its on-disk token still belongs to that
runner.

Exit codes:

- `0`: success
- `2`: invalid arguments or unsafe report request
- `3`: keyring readiness failure
- `4`: integrity blocker or missing invalid-row approval
- `5`: concurrent row change
- `6`: database, report, or retry-exhaustion failure
- `7`: verification failure
- `8`: runner lock conflict

Each batch uses `BEGIN IMMEDIATE`. A failed batch rolls back while previously
committed batches remain intact. Re-running skips encrypted rows without
rotating their ciphertext, IV, or migration timestamp.

Verify always inventories the complete `orders` table and decrypt-checks every
encrypted row. `--limit` and `--after-id` are rejected with `--verify`.
`--batch-size` controls only the internal read size and never reduces the
verification scope.
