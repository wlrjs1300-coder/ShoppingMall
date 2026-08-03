# 주문·결제 PII Production 활성화 Runbook

## 1. 목적과 범위

이 문서는 주문 PII 신규 write 암호화를 production에서 활성화하기 위한 승인·실행 절차다. 다음 작업을 하나의 maintenance window에서 수행한다.

- 검증된 DB backup 확보와 격리 restore rehearsal 확인
- order PII keyring readiness 확인
- legacy order inventory, backfill, 전체 verify
- legacy payment PII inventory, purge, 전체 verify
- runtime flag 활성화와 동일 application artifact 재시작
- synthetic smoke test, monitoring, rollback 판단, 증적 보관

범위 밖 작업은 key 생성, key material 문서화, invalid legacy 또는 orphan payment 자동 remediation, DB 평문 재작성, schema downgrade, provider API나 application code 변경, migration 추가다.

현재 저장소 기준은 `b5fb423be4a205aed585464e300ce42d3ae2e1d3`, 최신 migration은 16, startup 명령은 `cd server && npm start`다. 실제 실행 시 이 SHA를 배포 대상 SHA로 교체해 증적에 기록한다. Production DB는 저장소 밖 절대경로 `DB_PATH`를 사용한다. `ORDER_PII_PROTECTION_ENABLED`는 정확히 문자열 `"true"`일 때만 활성화되며 기본 상태는 OFF다.

## 2. 역할과 승인

한 사람이 여러 역할을 맡더라도 체크리스트에는 역할별 확인자를 구분해 기록한다.

| 역할 | 책임 |
|---|---|
| Operator | 승인된 명령 실행, 결과·시간·안전 오류 코드 기록 |
| Approver | activation gate, 예외, maintenance 해제 승인 |
| Application Owner | artifact, startup, health, smoke, application rollback 판단 |
| Database Owner | DB 경로, backup, restore rehearsal, SQLite 상태 확인 |
| Security Owner | keyring readiness, historical key 보존, 증적 비노출 검토 |
| Rollback Owner | rollback artifact 준비, 중단 기준 판단, 복구 지휘 |

## 3. 절대 금지

> **다음 작업은 이 절차에서 금지한다.**
>
> - Production DB를 restore rehearsal 대상으로 사용하거나 직접 덮어쓰기
> - keyring 원문, 전체 환경변수 dump, PII를 report·log·evidence에 저장
> - ciphertext, IV, auth tag, token hash, payment key, Toss secret 기록
> - verify 실패, partial tuple 또는 unknown key가 존재하는 상태에서 flag ON
> - orphan payment 자동 purge 또는 invalid legacy 자동 수정
> - keyring이나 historical decrypt key 제거
> - encrypted-read 미지원 artifact로 rollback
> - DB 평문 재작성, schema downgrade
> - 실제 고객 데이터나 provider 호출을 smoke test에 사용

## 4. 환경변수 계약

실제 값은 문서에 적지 않고 승인된 secret manager 또는 배포 환경에서 관리한다.

| 변수 | 계약 |
|---|---|
| `NODE_ENV` | Production apply와 startup은 `production` |
| `DB_PATH` | 저장소 밖 영구 volume의 절대경로 |
| `BACKUP_DIR` | 저장소 및 DB 디렉터리 밖의 별도 절대경로 |
| `ORDER_PII_KEYS_JSON` | canonical Base64 32-byte key를 가진 version 배열 |
| `ORDER_PII_ACTIVE_KEY_VERSION` | keyring에 존재하는 active version |
| `ORDER_PII_PROTECTION_ENABLED` | activation 직전까지 false, 정확히 `"true"`일 때 ON |
| `ORDER_PII_BACKFILL_LOCK_PATH` | 선택 사항. 승인된 운영 lock 경로 |
| `PAYMENT_PII_PURGE_LOCK_PATH` | 선택 사항. 승인된 운영 lock 경로 |

Keyring은 JSON parse, 항목 allowlist, canonical Base64, 32-byte 길이, version 형식·중복, active version 존재를 검증해야 한다. 허용되는 운영 출력은 active version 이름, known version 개수, readiness 성공 여부와 안전 오류 코드뿐이다. DB backup에는 keyring이 포함되지 않는다.

## 5. 사전 체크리스트

- [ ] 배포 대상 commit SHA와 artifact version을 기록했다.
- [ ] 동일 artifact의 rollback reference를 확보했다.
- [ ] rollback artifact가 migration 16과 encrypted read를 지원한다.
- [ ] Operator, Approver, 각 Owner를 지정했다.
- [ ] Production `DB_PATH`가 저장소 밖 절대경로임을 확인했다.
- [ ] `BACKUP_DIR`이 DB 디렉터리 및 저장소 밖임을 확인했다.
- [ ] restore rehearsal 증적을 Database Owner와 Approver가 승인했다.
- [ ] keyring readiness가 성공했다.
- [ ] active version과 필요한 모든 historical decrypt version의 보존을 확인했다.
- [ ] 안전 report 부모 디렉터리가 존재하며 새 파일명을 준비했다.
- [ ] 선택한 lock 경로의 권한과 소유자를 확인했다.
- [ ] maintenance 공지와 write freeze 시행·해제 담당자를 지정했다.
- [ ] synthetic test order 정책과 사후 정리 책임자를 승인했다.

## 6. Backup과 검증

담당: Database Owner 실행, Operator 기록, Approver 확인.

```powershell
cd C:\path\to\ShoppingMall\server
npm run backup:create
npm run backup:verify
npm run backup:verify -- --file shoppingmall-YYYYMMDDTHHMMSSZ.sqlite
```

`--file`은 전체 경로가 아니라 `BACKUP_DIR` 내부의 안전한 파일명만 받는다. Backup set은 `.sqlite`, `.sqlite.sha256`, `.json` 세 파일이다. 검증은 SHA-256, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, 필수 테이블, 주요 row count, 임시 restore copy를 확인한다.

성공 기준:

- [ ] 명령 exit code가 0이다.
- [ ] hash가 일치하고 integrity 결과가 `ok`다.
- [ ] foreign key violation이 0이다.
- [ ] 완전한 세 파일이 존재한다.
- [ ] 파일명, hash, 생성 시각, operator, 배포 SHA를 기록했다.

실패하면 maintenance를 유지하고 activation을 중단한다. 불완전 backup이나 검증 실패 backup으로 진행하지 않는다. Backup metadata에는 application commit이 독립 필드로 없으므로 SHA는 별도 증적에 기록한다.

## 7. 격리 Restore Rehearsal

자동 restore script나 HTTP restore API는 없다. Database Owner가 승인된 격리 환경에서 수동 수행한다.

1. 검증된 backup을 선택한다.
2. Production과 분리된 임시 디렉터리와 DB 파일을 만든다.
3. Backup SQLite를 임시 DB로 복사하되 원본을 변경하지 않는다.
4. Production과 다른 `DB_PATH`를 지정한다.
5. 필요한 keyring을 secret manager에서 격리 환경에 주입한다.
6. 배포 대상과 동일한 release artifact를 시작해 migration을 적용한다.
7. `/api/health`에서 database ready와 schema 16을 확인한다.
8. 승인된 synthetic encrypted row read를 확인한다.
9. Order와 payment verify를 실행한다.
10. 결과와 담당자 승인을 보관하고 임시 DB를 안전하게 폐기한다.

성공 기준은 startup 성공, schema 16, health ready, encrypted read 성공, 두 verify 성공이다. Production `DB_PATH` 사용, production DB overwrite, backup 원본 수정은 금지한다.

## 8. Maintenance와 Write Freeze

담당: Approver 승인, Application Owner 시행, Operator 확인.

Write freeze는 backup 시작 전부터 최종 readiness와 smoke가 성공할 때까지 유지한다. 다음 작업을 차단한다.

- 일반 주문, checkout, 관리자 주문 생성
- 관리자 PII 수정
- payment 생성·재발급·승인·취소·reconcile
- background notification과 encrypted read/write 의존 작업

이 범위는 flag OFF에서 신규 legacy order가 재유입되는 문제, SQLite single writer와 `BEGIN IMMEDIATE` 경합, inventory/apply/verify 사이의 불일치를 방지한다.

- [ ] Maintenance가 외부에 공지됐다.
- [ ] 신규 write가 0임을 확인했다.
- [ ] Background writer와 notification을 중지했다.
- [ ] 해제 권한이 Approver에게만 있음을 확인했다.

Write가 관측되면 즉시 중단하고 freeze를 복구한 뒤 backup부터 다시 시작한다.

## 9. Order PII Dry-run

담당: Operator 실행, Security Owner와 Database Owner 검토.

저장소 root에서 실행한다.

```powershell
cd C:\path\to\ShoppingMall
node server/scripts/backfill-order-pii.js --dry-run --report=<new-safe-report-path>
```

Report 부모 디렉터리는 미리 존재해야 하고 기존 파일은 덮어쓰지 않는다. Flag가 OFF여도 유효한 keyring이 필요하다.

검토 분류:

- `LEGACY_VALID`
- `LEGACY_INVALID`
- `PARTIAL_TUPLE`
- `UNKNOWN_KEY_VERSION`
- `ENCRYPTED_METADATA_MISMATCH`
- `ENCRYPTED_VALID`

`PARTIAL_TUPLE > 0`, `UNKNOWN_KEY_VERSION > 0`, keyring failure는 hard stop이다. `LEGACY_INVALID`는 안전 report의 ID/classification으로 대상을 식별하고 실제 내용은 secure channel에서 조사한다. 자동 수정하지 않는다.

## 10. Invalid Legacy 승인과 Remediation

`--allow-invalid-skip`은 임시 승인 수단일 뿐 activation 성공 조건이 아니다. Skip된 row가 남으면 전체 verify는 실패한다.

- [ ] Owner와 Approver가 대상을 검토했다.
- [ ] 실제 내용은 secure channel에서만 확인했다.
- [ ] 수동 remediation 계획과 기한을 기록했다.
- [ ] Remediation 후 dry-run을 반복했다.
- [ ] 최종 `LEGACY_INVALID`가 0이다.

예외 문서에는 owner, approver, 만료일, 위험 수락, remediation deadline을 포함할 수 있지만 현재 CLI는 예외만으로 verify 성공을 허용하지 않는다.

## 11. Order PII Apply와 Verify

```powershell
node server/scripts/backfill-order-pii.js --apply --batch-size=100 --confirm=BACKFILL_ORDER_PII
node server/scripts/backfill-order-pii.js --verify
```

`--confirm`은 `NODE_ENV=production`에서 필수다. Invalid skip을 승인한 경우에만 apply에 `--allow-invalid-skip`을 추가할 수 있으나 최종 gate는 통과하지 못한다.

Apply 성공 기준:

- [ ] Exit code 0
- [ ] processed/skipped/final cursor를 기록
- [ ] Partial tuple와 unknown key가 없음
- [ ] Safe summary만 증적에 보관

실패 시 maintenance를 유지한다. 현재 batch는 rollback되고 이전 batch는 유지되므로 안전 오류 코드를 조사한 뒤 재실행한다.

Verify 성공 기준:

```text
LEGACY_VALID = 0
LEGACY_INVALID = 0
PARTIAL_TUPLE = 0
UNKNOWN_KEY_VERSION = 0
ENCRYPTED_METADATA_MISMATCH = 0
decryptFailure = 0
```

Verify는 전체 DB 전용이며 `--limit`, `--after-id`를 사용할 수 없다. 실패하면 flag ON을 금지한다.

## 12. Payment PII Dry-run

```powershell
node server/scripts/purge-payment-pii.js --dry-run --report=<new-safe-report-path>
```

담당: Operator 실행, Database Owner 검토. Keyring은 필요하지 않다.

검토 항목:

- `PAYMENT_SAFE`
- `PAYMENT_LEGACY_PII_CONNECTED`
- `PAYMENT_LEGACY_PII_ORPHAN`
- `PAYMENT_ORPHAN_SAFE`
- metadata warnings와 order PII mode

Connected payment만 자동 purge 대상이다. Orphan은 변경하지 않는다. Metadata warning만으로 purge를 차단하거나 PII verify를 실패시키지 않는다.

## 13. Orphan Payment 승인과 Remediation

`PAYMENT_LEGACY_PII_ORPHAN`은 자동 purge하지 않는다.

1. Safe report의 payment ID, order ID, classification으로 대상을 식별한다.
2. Orphan 원인을 secure channel에서 조사한다.
3. Order 복구, payment 정리 또는 보존 정책을 Database·Security Owner가 결정한다.
4. Approver 승인 후 수동 remediation한다.
5. Payment dry-run과 verify를 반복한다.

예외에는 owner, approver, 만료일, 위험 수락, remediation deadline을 기록한다. 현재 CLI는 예외 문서만으로 verify 성공을 허용하지 않으므로 최종 activation 전에 orphan PII가 0이어야 한다.

## 14. Payment PII Apply와 Verify

```powershell
node server/scripts/purge-payment-pii.js --apply --batch-size=500 --confirm=PURGE_PAYMENT_PII
node server/scripts/purge-payment-pii.js --verify
```

Apply 성공 기준:

- [ ] Exit code 0
- [ ] Connected PII 처리 건수 기록
- [ ] Orphan과 모든 비-PII metadata 불변
- [ ] Safe summary 보관

실패하면 maintenance를 유지한다. 현재 batch rollback과 이전 batch 보존을 확인하고 안전 오류 코드를 해결한 뒤 재실행한다.

Verify 성공 기준:

```text
PAYMENT_LEGACY_PII_CONNECTED = 0
PAYMENT_LEGACY_PII_ORPHAN = 0
```

Verify는 전체 DB 전용이다. Orphan PII는 별도 remediation 후 다시 검증한다. Metadata warning만 남은 경우 PII verify는 성공할 수 있다.

## 15. Activation Gate

Approver는 아래 항목이 모두 충족될 때만 flag activation을 승인한다.

- [ ] Backup verify 성공
- [ ] Restore rehearsal 승인
- [ ] Keyring readiness 성공
- [ ] Active 및 historical key 보존 확인
- [ ] Order verify exit 0
- [ ] Payment verify exit 0
- [ ] Partial tuple와 unknown key 0
- [ ] Legacy valid/invalid 0
- [ ] Connected/orphan payment PII 0
- [ ] Encrypted-read 지원 rollback artifact 확인
- [ ] Maintenance와 write freeze 유지

하나라도 실패하면 activation을 중단한다.

## 16. Flag Activation, Restart, Readiness

담당: Application Owner 실행, Security Owner 확인, Approver 승인.

승인된 배포 환경에서 다음 값을 반영한다. 실제 secret 값은 문서나 증적에 기록하지 않는다.

```text
ORDER_PII_PROTECTION_ENABLED=true
```

Hot reload에 의존하지 않는다. Keyring과 historical key를 유지한 상태로 동일 artifact를 restart/redeploy한다.

재시작 전:

```powershell
cd server
npm run deploy:check
```

승인된 service manager/container 명령으로 재시작한다. 직접 실행 환경의 startup 명령은 다음과 같다.

```powershell
npm start
```

Readiness는 다음 네 항목을 모두 확인한다.

- [ ] `npm run deploy:check` error 0
- [ ] Service startup 성공
- [ ] `/api/health`가 `database: ready`, schema 16 반환
- [ ] Encrypted-read smoke 성공

`/api/health`만으로 keyring readiness를 확인할 수 없다. Startup이 실패하면 maintenance를 유지하고 flag/keyring/artifact 일치를 수정한다. Key를 제거하거나 encrypted-read 미지원 artifact로 즉시 downgrade하지 않는다.

## 17. Synthetic Smoke Test

Application Owner가 승인된 synthetic data만 사용한다.

1. 일반 주문 1건
2. Checkout 1건
3. 관리자 주문 1건
4. Payment link read
5. 관리자 PII access와 structured audit
6. Notification encrypted read

DB에서는 값 자체가 아니라 다음 metadata 계약만 확인한다.

- `customer_name`, `customer_phone`이 `[protected]`
- `delivery_address`, `guest_address`가 `NULL`
- Crypto tuple이 complete
- Active key version과 masked metadata 존재
- Payment `customer_name`, `customer_phone`이 `NULL`

API에서는 public/admin 일반 응답 마스킹, PII access 감사, payment link masked name, notification 성공을 확인한다. Synthetic PII 원문, ciphertext, token, payment key, secret은 증적에 남기지 않는다.

Smoke 실패 시 maintenance를 유지하고 rollback 판단으로 이동한다. 모든 smoke가 성공한 뒤에만 Approver가 maintenance 해제를 승인한다.

## 18. Rollback 원칙과 장애별 대응

Flag OFF만으로 완전 rollback할 수 없다. 암호화된 row를 읽으려면 keyring, active/historical key, migration 16 호환 application, encrypted-read 지원 artifact가 계속 필요하다.

금지:

- Keyring 또는 historical key 제거
- Encrypted row 평문 변환
- Schema downgrade
- Encrypted-read 미지원 release로 rollback

장애별 대응:

| 장애 | 즉시 대응 |
|---|---|
| Readiness/startup 실패 | Maintenance 유지, env/keyring/artifact 수정 후 재시작 |
| 신규 write 실패 | Write 차단, flag·keyring·artifact 일치 확인, 기존 encrypted row 유지 |
| Decrypt/access failure 급증 | Write 중단, key version과 artifact 확인, 누락 historical key 복구 |
| Checkout 5xx | Checkout 격리, DB/payment 상태 조사, order encryption 유지 |
| `SQLITE_BUSY` 급증 | Runner 중단, writer 확인, maintenance 강화 후 재시도 |
| Notification 실패 | Notification만 일시 중단하고 order encryption 유지 |
| Payment 장애 | Payment flow 격리, order encryption 유지 |

DB restore는 예상 데이터 손실을 평가하고 Database Owner와 Approver가 별도 승인한 최후 수단이다. Service를 중지하고 검증된 backup과 기존 DB/WAL/SHM 보존 절차를 따라야 한다.

## 19. Monitoring과 Post-activation

즉시 감시할 안전 오류 코드와 지표:

- `ORDER_PII_ENCRYPTION_FAILED`
- `ORDER_PII_ACCESS_FAILED`
- `ORDER_PII_DECRYPTION_FAILED`
- `CHECKOUT_CREATE_FAILED`
- `SQLITE_BUSY`
- Checkout/payment 5xx
- Notification failure

Raw SQL보다 전체 verify CLI를 우선 사용한다.

```powershell
node server/scripts/backfill-order-pii.js --verify
node server/scripts/purge-payment-pii.js --verify
```

즉시:

- [ ] Deploy check, startup, health, 두 verify 성공
- [ ] Schema 16
- [ ] Synthetic smoke 성공
- [ ] 안전 오류 코드 급증 없음

24시간:

- [ ] 신규 legacy order 0
- [ ] Connected/orphan payment PII 0
- [ ] Partial/unknown/decrypt failure 0
- [ ] Checkout/payment 5xx 안정
- [ ] `SQLITE_BUSY`와 notification 안정

7일:

- [ ] Backup create/verify 성공
- [ ] Active/historical key version 분포 확인
- [ ] Orphan 증가 없음
- [ ] 예외 remediation 완료
- [ ] Monitoring 정상

## 20. Evidence Checklist

- [ ] Deployment commit SHA와 artifact version
- [ ] Activation timestamp, Operator, Approver
- [ ] Backup filename, hash, verify summary
- [ ] Restore rehearsal 결과와 승인
- [ ] Order dry-run/apply/verify summary와 safe report 경로
- [ ] Payment dry-run/apply/verify summary와 safe report 경로
- [ ] Deploy check, health, smoke 결과
- [ ] Maintenance 시작·해제 시각
- [ ] Rollback artifact reference
- [ ] 예외 owner, approver, 만료일, remediation deadline
- [ ] 증적에 PII, key, token, provider secret, ciphertext가 없음을 Security Owner가 확인

## 21. Exit Code Quick Reference

Order backfill:

| Code | 의미 |
|---:|---|
| 0 | 성공 |
| 2 | Argument 또는 report 오류 |
| 3 | Keyring readiness 실패 |
| 4 | Integrity blocker 또는 invalid 승인 누락 |
| 5 | Concurrent change |
| 6 | DB, report 또는 retry 실패 |
| 7 | Verify 실패 |
| 8 | Runner lock 충돌 |

Payment purge:

| Code | 의미 |
|---:|---|
| 0 | 성공 |
| 2 | Argument 또는 report 오류 |
| 4 | Reserved integrity blocker |
| 5 | Concurrent change |
| 6 | DB, report 또는 retry 실패 |
| 7 | Verify 실패 |
| 8 | Runner lock 충돌 |

## 22. Command Quick Reference

```powershell
# Backup
cd C:\path\to\ShoppingMall\server
npm run backup:create
npm run backup:verify
npm run backup:verify -- --file <backup-file-name>

# Production configuration readiness
npm run deploy:check

# Repository root
cd C:\path\to\ShoppingMall

# Order PII
node server/scripts/backfill-order-pii.js --dry-run --report=<new-safe-report-path>
node server/scripts/backfill-order-pii.js --apply --batch-size=100 --confirm=BACKFILL_ORDER_PII
node server/scripts/backfill-order-pii.js --verify

# Payment PII
node server/scripts/purge-payment-pii.js --dry-run --report=<new-safe-report-path>
node server/scripts/purge-payment-pii.js --apply --batch-size=500 --confirm=PURGE_PAYMENT_PII
node server/scripts/purge-payment-pii.js --verify

# Direct startup (use the approved service manager in production)
cd server
npm start
```

`<new-safe-report-path>`, `<backup-file-name>`, `<approved-lock-path>`는 운영자가 승인된 실제 경로·파일명으로 치환하는 비밀이 아닌 placeholder다. Secret placeholder나 실제 secret 값은 이 문서에 추가하지 않는다.
