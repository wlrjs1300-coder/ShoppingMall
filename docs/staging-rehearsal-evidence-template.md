# Staging rehearsal evidence template

이 문서는 실제 rehearsal 전에는 비어 있어야 한다. 상태 기본값은 `NOT_STARTED`이며 실제 secret, PII, 경로 또는 artifact를 기록하지 않는다.

## 1. Document metadata

| Field | Value |
| --- | --- |
| rehearsal date | `<YYYY-MM-DD>` |
| operator | `<role-or-redacted-reference>` |
| reviewer | `<role-or-redacted-reference>` |
| repository commit SHA | `<commit-sha>` |
| deployment reference | `<redacted-deployment-reference>` |
| application version | `<version>` |
| evidence classification | `<repository-safe-or-private-only>` |

## 2. Environment identity

| Field | Value |
| --- | --- |
| APP_ENV | `<staging>` |
| schema version | `<integer>` |
| single instance confirmed | `<NOT_STARTED>` |
| persistent disk confirmed | `<NOT_STARTED>` |
| provider disabled confirmed | `<NOT_STARTED>` |
| secret values not recorded | `<NOT_STARTED>` |

## 3. Phase 0~13 checklist

각 Phase의 status는 `NOT_STARTED`, `PASS`, `FAIL`, `BLOCKED`, `SKIPPED` 중 하나만 사용한다.

| Phase | Status | startedAt | completedAt | Command or manual step | Expected result | Observed safe summary | Stop reason | Rollback/cleanup | Evidence reference |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<command>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 1 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<manual platform step>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 2 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<manual platform step>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 3 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<command>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 4 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<manual platform step>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 5 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<command>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 6 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<command>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 7 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<manual platform step>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 8 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<command>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 9 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<manual platform step>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 10 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<command>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 11 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<command>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 12 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<manual platform step>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |
| 13 | NOT_STARTED | `<timestamp>` | `<timestamp>` | `<manual platform step>` | `<safe expectation>` | `<safe summary>` | `<none-or-safe-category>` | `<action>` | `<reference>` |

## 4. Safe evidence tables

| Evidence | Status | Safe summary | Evidence reference |
| --- | --- | --- | --- |
| preflight summary | NOT_STARTED | `<safe-summary>` | `<reference>` |
| health summary | NOT_STARTED | `<safe-summary>` | `<reference>` |
| seed summary | NOT_STARTED | `<safe-summary>` | `<reference>` |
| smoke summary | NOT_STARTED | `<safe-summary>` | `<reference>` |
| restart persistence summary | NOT_STARTED | `<safe-summary>` | `<reference>` |
| backup create/verify summary | NOT_STARTED | `<safe-summary>` | `<private-reference>` |
| isolated restore summary | NOT_STARTED | `<safe-summary>` | `<private-reference>` |
| backfill dry-run/apply/verify summary | NOT_STARTED | `<safe-summary>` | `<private-reference>` |
| purge dry-run/apply/verify summary | NOT_STARTED | `<safe-summary>` | `<private-reference>` |
| rollback summary | NOT_STARTED | `<safe-summary>` | `<private-reference>` |
| monitoring closure | NOT_STARTED | `<safe-summary>` | `<reference>` |

## 5. Evidence retention boundary

### Repository-safe

- aggregate counts, pass/fail, `schemaVersion`, safe category
- sanitized screenshot reference, commit SHA, redacted deployment reference

### Private-only

- policy상 필요한 실제 deploy ID/time, raw logs, backup filename/hash
- report identifiers와 operational screenshots

### Prohibited

- secret, JWT, cookie, Authorization header, PII, key material, provider credential
- DB absolute path, backup DB file, raw environment dump, raw response body

## 6. Safe summary schema

문서용 공통 필드는 `phase`, `status`, `timestamp`, `commitSha`, `schemaVersion`, `checksTotal`, `passed`, `failed`, `created`, `reused`, `repaired`, `conflicts`, `processed`, `blockers`, `warnings`, `providerTriggeringRequests`, `safeCategory`, `evidenceReference`다. 값이 없으면 생략할 수 있다. Raw path, raw URL 및 Prohibited 항목은 포함하지 않는다. 실제 backup basename/hash/report ID는 Private-only evidence에만 둔다.

## 7. Final approval

| Field | Value |
| --- | --- |
| completion criteria | `<NOT_STARTED>` |
| unresolved risks | `<none-or-sanitized-summary>` |
| reviewer decision | `<NOT_STARTED>` |
| production promotion | `<PROHIBITED-or-APPROVED>` |
