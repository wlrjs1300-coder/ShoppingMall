# Payment PII purge

This runbook removes the legacy `customer_name` and `customer_phone` copies from
the `payments` table. It does not decrypt order PII, call a payment provider, or
change payment/order application routes.

## Safety policy

- Only a payment whose `order_id` currently resolves to an `orders` row is
  eligible for automatic purge.
- A connected payment is eligible in every payment status. The known status
  inventory is `PENDING`, `FAILED`, `CONFIRMING`, `DONE`, `CANCELED`,
  `PARTIAL_CANCELED`, `RECONCILE_REQUIRED`, and `CANCELING`.
- An unknown status adds `PAYMENT_STATUS_UNKNOWN` but remains eligible. Purge
  never changes the status.
- An orphan payment is never changed or deleted. Orphan PII is reported and
  causes verification to fail so that an operator can investigate it.
- The update sets only `payments.customer_name` and
  `payments.customer_phone` to `NULL`. Payment keys, token hashes, amounts,
  statuses, timestamps, errors, and all other columns are preserved.
- Metadata warnings are inventory signals. They neither block an otherwise
  eligible purge nor make verification fail.
- A normal `PAYMENT_SAFE` row contributes to aggregates but is omitted from
  details and reports. A `PAYMENT_SAFE` row with at least one metadata warning
  is included in safe details/reports, but is not a purge target and does not
  make PII verification fail.

The inventory classifications are:

- `PAYMENT_SAFE`: connected and no payment PII
- `PAYMENT_LEGACY_PII_CONNECTED`: connected and contains payment PII
- `PAYMENT_LEGACY_PII_ORPHAN`: orphan and contains payment PII
- `PAYMENT_ORPHAN_SAFE`: orphan and no payment PII

Order PII is reported only as metadata (`ENCRYPTED`, `LEGACY`, `PARTIAL`, or
`NO_ORDER`). No order keyring is required.

## Commands

Run from `server`:

```text
npm run pii:payments:dry-run
node scripts/purge-payment-pii.js --apply --batch-size=500
npm run pii:payments:verify
```

Dry-run is the default mode. Exactly one of `--dry-run`, `--apply`, and
`--verify` may be selected. `--batch-size` accepts 1 through 5000 and defaults
to 500. Dry-run and apply support positive `--limit`, lexical `--after-id`, and
`--report=<existing-parent/new-file.jsonl>`.

Production apply requires:

```text
node scripts/purge-payment-pii.js --apply --confirm=PURGE_PAYMENT_PII
```

There is deliberately no option to include orphans.

## Verify contract

Verify always inventories the entire `payments` table. It rejects `--limit`
and `--after-id`; `--batch-size` is only an internal processing-size setting
and never reduces verification scope.

Verification succeeds only when both connected legacy PII and orphan legacy
PII counts are zero. Orphan rows without PII and metadata warnings are allowed.
Verify never mutates data.

## Reports and logs

JSONL reports use an explicit safe-field allowlist and refuse to overwrite an
existing destination. The parent directory must already exist, and the file is
published atomically.

Reports never contain customer names or phones, token hashes, payment keys,
provider secrets, cancellation reasons, last errors, or receipt URLs. Console
output contains aggregate counts only.

The purge preserves all non-PII fields, including amount, order name, status,
payment key, requested/paid/canceled timestamps, link and session metadata,
cancel/reconcile metadata, and provider metadata.

## Concurrency and recovery

Apply processes payment IDs in lexical order using `BEGIN IMMEDIATE` batches.
Each row is re-read with its connected order immediately before update. The
compare-and-update predicate includes ID, order ID, and the two original PII
values. A mismatch rolls back the current batch with exit code 5; earlier
committed batches remain safe to rerun.

The runner lock contains a random private owner token. A lock is replaced only
when it is older than six hours, parses safely, and its PID is confirmed
inactive. Malformed locks fail closed. Release removes a lock only when the
owner token still matches, so an older runner cannot delete a replacement
lock. SQLite busy operations use three bounded exponential retries.

## Exit codes

- `0`: successful dry-run, apply, or verify
- `2`: invalid arguments or report destination
- `4`: integrity blocker (reserved)
- `5`: concurrent row change
- `6`: database, report, or exhausted busy-retry failure
- `7`: verification found payment PII
- `8`: runner lock conflict

Before production use, back up the database, run dry-run with a protected
report destination, review orphan PII separately, apply during a controlled
window, and run full verification.
