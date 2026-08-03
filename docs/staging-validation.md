# Staging validation

## 1. 목적과 상태

이 문서는 실제 고객 데이터와 외부 provider 없이 production 보안 경계를 검증하는 staging 계약이다.

- **Implemented contract:** `APP_ENV`, provider 차단, DB 경로 marker, read-only preflight, Render Blueprint, synthetic seed와 HTTP smoke runner
- **Not Yet Executed on Render:** 실제 서비스 생성, disk 보존 확인, seed/smoke 실행, backup 복원, PII backfill/purge, rollback과 monitoring 증거

## 2. 환경 분리

| 항목 | staging | production |
| --- | --- | --- |
| runtime | `NODE_ENV=production`, `APP_ENV=staging` | `NODE_ENV=production`, `APP_ENV=production` |
| 서비스·disk·secret | staging 전용 | production 전용 |
| 데이터 | synthetic only | 승인된 운영 데이터 |
| provider | 모두 disabled | 승인된 provider만 활성 |

두 환경은 DB, backup, JWT secret, pepper, keyring, 관리자 계정을 공유하지 않는다.

## 3. Render service와 persistent storage

`render.staging.yaml`은 `tteokjip-staging` web service와 `tteokjip-staging-data` 1GB disk를 선언한다. mount는 `/data`, DB는 `/data/staging.sqlite`, backup은 `/data/backups`다. SQLite를 사용하는 동안 instance는 하나만 운영하며 수평 확장하지 않는다.

disk가 runtime에 mount된 뒤 서버 시작 과정에서 migration이 수행된다. build 또는 pre-deploy 단계에서 DB, seed, backup 작업을 실행하지 않는다.

## 4. 환경 변수와 provider 정책

필수 공개 설정은 staging HTTPS `PUBLIC_BASE_URL`과 동일 origin의 `ALLOWED_ORIGIN`, 공개용 staging 매장 정보다. `JWT_SECRET`과 `AUTH_CODE_PEPPER`는 플랫폼에서 생성·보관한다.

다음 값은 고정한다.

```text
PAYMENT_MODE=disabled
TOSS_MOCK_MODE=false
NOTIFICATION_MODE=none
EMAIL_MODE=disabled
NAVER_COMMERCE_SYNC_ENABLED=false
NAVER_ORDER_IMPORT_ENABLED=false
ALLOW_LEGACY_ADMIN_LOGIN=false
```

Toss, Solapi/Kakao, Resend, OAuth, Naver Commerce/import credential은 staging에 설정하지 않는다. 일부 credential만 설정하거나 provider를 활성화하면 preflight와 서버 시작 검증이 실패한다.

## 5. 배포 sequence와 gate

```text
npm ci
→ npm test
→ npm run deploy:check
→ Render deploy
→ GET /api/health
→ database=ready, schemaVersion=16 확인
```

`deploy:check`는 DB·backup 파일을 만들지 않고 외부 연결도 수행하지 않는다. 출력에는 환경 구분과 경로의 external 여부, staging provider disabled 상태만 나타나며 실제 경로, secret, credential, keyring은 출력하지 않는다.

## 6. Synthetic seed

Seed는 DB 모듈을 불러오기 전에 다음 조건을 모두 확인한다.

```text
NODE_ENV=production
APP_ENV=staging
ALLOW_STAGING_SEED=true
```

필요한 secret은 `STAGING_SUPER_ADMIN_PASSWORD`, `STAGING_OPERATIONS_PASSWORD`, `STAGING_FINANCE_PASSWORD`, `STAGING_VIEWER_PASSWORD`, `STAGING_CUSTOMER_PASSWORD`, `ORDER_PII_KEYS_JSON`, `ORDER_PII_ACTIVE_KEY_VERSION`이다. 실제 값은 Render secret manager에만 입력한다. `ALLOW_STAGING_SEED`는 일반 서버 실행에 필요하지 않으며 수동 실행 창에서만 정확히 `true`로 설정한다.

```bash
cd server
npm run staging:seed
```

Seed는 super_admin·operations·finance·viewer와 고객 계정, legacy 주문, encrypted PII 주문 2개, 연결된 legacy payment PII fixture를 고정 `staging-synthetic-` namespace에 생성한다. canonical 상품은 기존 seed를 조회할 뿐 가격이나 상태를 덮어쓰지 않는다. 전체 작업은 한 transaction이며 재실행 시 중복을 만들지 않는다. 예상하지 않은 ID·username·email·order/payment 충돌은 전체 rollback한다. 자동 cleanup과 기존 portfolio/demo seed 재사용은 하지 않는다.

## 7. HTTP smoke

`STAGING_BASE_URL`은 `PUBLIC_BASE_URL`과 동일한 HTTPS origin이어야 하며 hostname의 첫 label이 `staging`이거나 `-staging`으로 끝나야 한다. localhost, 예제 hostname, path/query/fragment는 실제 실행에서 거부한다.

```bash
cd server
npm run staging:smoke
```

Smoke는 health/schema 16, active 상품, 고객 cookie 인증, 네 관리자 역할의 session 교환, viewer write 차단, operations 주문·재고 read, finance 결제 read, 권한 없는 PII 접근 차단, 주문 목록 PII 마스킹, 승인된 PII read/update와 `no-store`, 감사 로그, payment provider disabled, 내부 파일 404를 확인한다. PII update 전용 fixture는 두 synthetic 이름을 번갈아 사용하므로 반복 실행할 수 있다.

Runner는 `STAGING_SMOKE_TIMEOUT_MS`(기본 10000ms, 최대 60000ms)를 모든 요청에 적용하고 staging origin의 정확히 허용된 route만 요청한다. Toss confirm/reconcile/cancel/webhook, OAuth, Naver sync/import 같은 provider-triggering route는 fetch 전에 차단하고 시도 횟수를 `providerTriggeringRequests`로 계측한다. 정상 smoke summary에서 이 값은 0이어야 하며, 이는 smoke가 위험 route를 요청하지 않았다는 뜻이지 서버 내부 provider outbound의 직접 계측값은 아니다. 비밀번호, cookie, JWT, PII, keyring, 응답 body 전체는 출력하거나 파일로 저장하지 않는다.

Synthetic fixture는 staging 전용 DB에서 삭제보다 재사용·복원을 우선한다. 실제 데이터와 혼합하거나 production에 복사하지 않는다.

## 8. Backup, restore, PII rehearsal

`backup:create` 후 `backup:verify`를 통과한 artifact만 격리 경로에 복사한다. 자동 restore는 사용하지 않으며 서비스를 분리한 상태에서 다른 `DB_PATH`로 기동해 health와 안전한 집계를 확인한다. 같은 disk의 backup 외에 별도 장애 영역 사본을 보관한다.

Order backfill과 payment purge는 staging keyring과 synthetic legacy data만 사용해 `dry-run → backup/verify → apply → verify` 순서로 실행한다. blocker, orphan, decrypt 실패가 있으면 apply 또는 완료 판정을 중단한다.

## 9. Rollback과 monitoring

startup, health, schema, DB open/migration, keyring/decrypt, backup verify, backfill/purge, provider config, `SQLITE_BUSY` 실패 시 promotion을 중단한다. application rollback은 DB를 자동 복원하지 않는다.

최소 monitoring은 외부 health probe, process restart, 5xx, `RECONCILE_REQUIRED`, PII 실패, `SQLITE_BUSY`, backup 실패·최신성, disk 사용량을 포함한다.

## 10. 완료 기준

- [ ] 별도 HTTPS service와 persistent disk
- [ ] restart 후 synthetic DB 유지, instance 1개
- [ ] deploy preflight와 전체 테스트 통과
- [ ] health `database=ready`, schema version 16
- [ ] 외부 provider 호출 0건과 credential 비설정
- [ ] Render에서 synthetic seed/smoke 성공
- [ ] backup create/verify와 격리 restore 성공
- [ ] backfill/purge와 rollback rehearsal 성공
- [ ] secret·PII·token 비노출 증거 보관

## 11. 금지 사항

`NODE_ENV=staging`, production 검증 완화, mock provider 허용, production seed guard 우회, 실제 고객 데이터·provider credential 사용, 다중 SQLite instance, 자동 DB restore를 금지한다.

## 12. `ALLOW_STAGING_SEED` lifecycle

1. 일반 서버 실행에서는 unset 또는 `false`로 둔다.
2. 수동 seed 실행 직전에만 정확히 `true`로 설정한다.
3. Smoke도 같은 guard를 요구하므로 seed 성공 후 smoke 완료까지 임시 유지한다.
4. smoke 완료 직후 unset 또는 `false`로 되돌린다.
5. restart persistence 확인을 위해 seed 재실행이 필요하면 승인된 짧은 창에서만 다시 `true`로 설정한다.
6. 확인 완료 즉시 다시 비활성화한다.
7. production에서는 어떤 경우에도 설정하지 않는다.

Blueprint에 `true`를 하드코딩하지 않으며 start/build/predeploy에 seed나 smoke를 연결하지 않는다.

## 13. Staging rehearsal Phase 0~13

모든 관찰 결과는 [evidence template](staging-rehearsal-evidence-template.md)의 safe summary 형식으로 기록한다. 실제 platform 조작은 `manual platform step`이며 저장소 문서가 특정 UI나 storage provider 명령을 추측하지 않는다.

### Phase 0. Local verification

- Prerequisites: clean rehearsal branch와 승인된 commit.
- Command: `cd server && npm test`.
- Expected: 전체 test pass 집계만 출력.
- Pass/stop: failed/skipped 0이면 통과하고 그 외에는 중단한다.
- Rollback/cleanup: mutation이 없으므로 없음.
- Evidence: commit SHA와 test aggregate.

### Phase 1. Render service creation

- Prerequisites: `render.staging.yaml` 검토.
- Step: 별도 service, 1GB persistent disk, 단일 instance를 만드는 `manual platform step`.
- Expected: staging 전용 service/disk identity.
- Pass/stop: disk 미연결 또는 다중 instance이면 중단한다.
- Rollback/cleanup: 사용 전 잘못 만든 staging resource만 platform 승인 절차로 정리한다.
- Evidence: redacted service reference와 단일 instance 확인.

### Phase 2. Environment and secret setup

- Prerequisites: public 설정과 secret 담당자 분리.
- Step: Blueprint 변수와 secret manager 값을 입력하는 `manual platform step`.
- Expected: provider-disabled 계약, staging DB marker, 실제 값 비기록.
- Pass/stop: 누락, placeholder, provider credential 또는 production 공유 secret 발견 시 중단한다.
- Rollback/cleanup: 잘못 입력한 값을 제거하고 secret rotation 필요성을 검토한다.
- Evidence: 변수명별 configured/absent 상태만 기록.

### Phase 3. Rehearsal guard and deploy preflight

- Prerequisites: Phase 2 완료, DB 파일을 열지 않는 상태.
- Commands: `cd server && npm run staging:rehearsal:check && npm run deploy:check`.
- Expected: `ready=true`, staging/external/disabled/matched identity와 preflight errors 0.
- Pass/stop: safe category 실패 또는 preflight error가 하나라도 있으면 중단한다.
- Rollback/cleanup: 환경 설정만 교정하고 mutation 명령은 실행하지 않는다.
- Evidence: safe summary와 preflight aggregate.

### Phase 4. First deploy and health

- Prerequisites: guard와 preflight 통과.
- Step: 승인된 artifact deploy와 HTTPS `GET /api/health` 확인인 `manual platform step`.
- Expected: HTTP 200, `database=ready`, `schemaVersion=16`.
- Pass/stop: startup, DB open, migration 또는 health 실패 시 중단한다.
- Rollback/cleanup: service를 격리하고 compatible artifact/config를 복구한다. DB 자동 restore는 하지 않는다.
- Evidence: redacted deploy reference와 health safe fields.

### Phase 5. Synthetic seed

- Prerequisites: `ALLOW_STAGING_SEED=true`인 승인된 짧은 창과 synthetic-only DB.
- Command: `cd server && npm run staging:seed`.
- Expected: created/reused/repaired/conflicts와 fixture counts, schema version.
- Pass/stop: conflict 또는 non-synthetic identity 발견 시 중단한다.
- Rollback/cleanup: seed 자체 transaction rollback에 의존하고 destructive cleanup은 하지 않는다.
- Evidence: seed safe summary.

### Phase 6. HTTPS smoke

- Prerequisites: Phase 5 성공, opt-in 임시 유지, HTTPS staging origin.
- Command: `cd server && npm run staging:smoke`.
- Expected: failed 0, schema 16, `providerTriggeringRequests=0`.
- Pass/stop: timeout, RBAC/PII/provider/static-boundary 실패 시 중단한다.
- Rollback/cleanup: smoke 완료 직후 `ALLOW_STAGING_SEED`를 unset 또는 `false`로 되돌린다.
- Evidence: smoke safe summary만 보존한다.

### Phase 7. Restart and disk persistence

- Prerequisites: opt-in 비활성, Phase 6 성공.
- Step: service restart와 health/fixture persistence 확인인 `manual platform step`.
- Expected: health ready/schema 16과 fixture 유지.
- Pass/stop: DB 초기화, fixture 소실 또는 instance 수 불일치 시 중단한다.
- Rollback/cleanup: 필요 시 승인된 짧은 opt-in 창에서 seed를 재실행하고 즉시 비활성화한다.
- Evidence: restart 전후 aggregate와 redacted restart reference.

### Phase 8. Backup create/verify

- Prerequisites: approved backup directory와 Phase 7 통과.
- Commands: `cd server && npm run backup:create && npm run backup:verify -- --file <approved-backup-basename>`.
- Expected: 3-file set, checksum 일치, integrity ok, FK violation 0.
- Pass/stop: incomplete set 또는 verify 실패 시 중단한다.
- Rollback/cleanup: 실패 artifact는 복구 입력으로 사용하지 않는다.
- Evidence: repository에는 pass/fail만, basename/hash는 Private-only로 보존한다.

### Phase 9. Isolated restore rehearsal

- Prerequisites: Phase 8의 검증된 backup과 동일 release artifact/historical keyring.
- Step: 별도 service/disk 또는 승인된 격리 환경에 SQLite 파일을 전달하는 `manual platform step`.
- Expected: 원본과 다른 `DB_PATH`, health ready/schema 16, synthetic encrypted read 성공.
- Commands after isolated startup: repository root에서 `node server/scripts/backfill-order-pii.js --verify`, server에서 `npm run pii:payments:verify`.
- Pass/stop: 원본 staging DB 접근·덮어쓰기, keyring 누락 또는 verify 실패 시 중단한다.
- Rollback/cleanup: 결과 기록 후 격리 process와 임시 DB를 승인 절차로 폐기한다.
- Evidence: safe health/verify summary와 private operational reference.

자동 restore CLI 없음, HTTP restore route 없음이 현재 계약이다. Traffic/process를 원본과 격리하고 검증된 3-file set 중 SQLite 파일만 별도 위치에 수동 복사한다. Platform-specific 전달 방식은 `manual platform step`이다.

### Phase 10. Order PII backfill dry-run/apply/verify

- Prerequisites: write freeze, Phase 8 backup/verify, guard 재통과, valid keyring.
- Commands from repository root:
  - `node server/scripts/backfill-order-pii.js --dry-run --report=<new-safe-report-path>`
  - `node server/scripts/backfill-order-pii.js --apply --batch-size=100 --confirm=BACKFILL_ORDER_PII`
  - `node server/scripts/backfill-order-pii.js --verify`
- Expected: partial/unknown/invalid/decrypt failure 0, apply safe processed count.
- Pass/stop: blocker, report collision, lock, concurrent change, `SQLITE_BUSY` 또는 verify 실패 시 중단한다.
- Rollback/cleanup: 현재 batch만 자동 rollback된다. 이전 batch는 verified backup과 별도 승인 없이는 되돌리지 않는다.
- Evidence: aggregate와 safe category; report reference는 Private-only.

### Phase 11. Payment PII purge dry-run/apply/verify

- Prerequisites: write freeze와 Phase 10 통과.
- Commands from `server`:
  - `npm run pii:payments:dry-run`
  - `node scripts/purge-payment-pii.js --apply --batch-size=500 --confirm=PURGE_PAYMENT_PII`
  - `npm run pii:payments:verify`
- Expected: connected/orphan legacy PII 0, 상태와 기타 payment metadata 유지.
- Pass/stop: orphan PII, lock, concurrent change, `SQLITE_BUSY` 또는 verify 실패 시 중단한다.
- Rollback/cleanup: 현재 batch만 rollback된다. DB file rollback은 별도 승인 사항이다.
- Evidence: aggregate와 safe category; report reference는 Private-only.

### Phase 12. Application rollback rehearsal

- Prerequisites: schema 16과 encrypted read를 지원하는 rollback artifact.
- Step: 승인된 compatible artifact로 전환하는 `manual platform step`.
- Expected: DB 자동 restore 없이 health/schema/encrypted read 유지.
- Pass/stop: migration down 요구, historical key 제거 또는 encrypted read 비호환이면 중단한다.
- Rollback/cleanup: 현재 compatible artifact로 다시 전환하고 DB는 변경하지 않는다.
- Evidence: 두 artifact의 redacted reference와 safe health/smoke 결과.

### Phase 13. Monitoring and evidence closure

- Prerequisites: 앞 Phase의 PASS 또는 승인된 BLOCKED 기록.
- Step: 5xx, PII failure, `SQLITE_BUSY`, backup failure, provider configuration을 검토하는 `manual platform step`.
- Expected: unresolved blocker 0과 Prohibited evidence 0.
- Pass/stop: raw secret/PII 발견 또는 중요 오류 증가 시 promotion을 금지한다.
- Rollback/cleanup: evidence를 retention boundary에 따라 분리·삭제한다.
- Evidence: reviewer decision과 sanitized closure summary.

## 14. External failure-domain backup copy

같은 Render disk의 backup은 독립 DR 사본이 아니다. `backup:verify` 통과 후 승인된 운영자가 Render disk와 다른 `different failure domain`으로 수동 export/copy한다. 구체적인 provider/storage 명령은 추측하지 않고 `manual platform step`으로 남긴다. 저장소에는 DB 파일, 실제 hash, 실제 경로를 커밋하지 않으며 copy 성공 여부와 대상 측 verification 결과만 evidence에 기록한다.

## 15. Safe summary schema

공통 기록 필드는 `phase`, `status`, `timestamp`, `commitSha`, `schemaVersion`, `checksTotal`, `passed`, `failed`, `created`, `reused`, `repaired`, `conflicts`, `processed`, `blockers`, `warnings`, `providerTriggeringRequests`, `safeCategory`, `evidenceReference`다. 값이 없는 필드는 생략할 수 있다. PII, secret, key, token, cookie, Authorization, raw path, raw URL, raw response body는 금지한다. 실제 backup basename/hash/report ID는 Private-only evidence로 분리한다.

이 runbook과 template은 실행 계약만 제공하며 실제 Render rehearsal 완료를 주장하지 않는다.
