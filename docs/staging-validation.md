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
