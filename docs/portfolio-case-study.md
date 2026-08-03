# Portfolio Case Study

이 문서는 따뜻한 떡집에서 단순한 정상 흐름보다 실패 시나리오를 어떻게 다뤘는지 설명합니다. 각 사례는 문제, 위험, 선택, 구현, 검증과 trade-off 순서로 정리했습니다.

## 1. Provider 성공 후 local DB 실패

### 문제

Toss 승인은 성공했지만 네트워크 응답이 유실되거나 local DB transaction이 실패하면 애플리케이션은 결제 성공 여부를 즉시 확정할 수 없습니다.

### 위험

- 실패로 잘못 표시한 뒤 고객이 재결제할 수 있습니다.
- 성공으로 간주하면 실제 미승인 주문을 생산·배송할 수 있습니다.
- 운영자가 local 상태만 강제로 바꾸면 provider와의 불일치가 고착됩니다.

### 선택

모호한 결과를 일반 실패와 분리한 `RECONCILE_REQUIRED` 상태로 보존하고, provider 조회에 기반한 reconcile 경로를 만들었습니다.

### 구현

- 승인 전에 `CONFIRMING` 상태와 idempotency key를 저장합니다.
- 명시적인 provider 4xx 거절과 timeout/5xx를 구분합니다.
- Provider 성공 뒤 local 반영이 실패하면 전체 local transaction을 rollback하고 재조정 필요 상태를 남깁니다.
- Reconcile은 provider 주문 ID, payment key, 금액과 상태를 local record와 대조합니다.
- 이미 처리된 webhook·승인·reconcile은 멱등 응답으로 수렴합니다.
- Reconcile 성공이 이미 진행된 업무 workflow를 이전 상태로 되돌리지 않게 합니다.

### 검증

테스트에서 provider timeout, 5xx, 승인 후 DB 실패, 금액·주문 ID·payment key 불일치, webhook과 reconcile 동시 실행, 반복 reconcile을 주입했습니다. 응답과 감사 로그에 provider secret이나 payment key가 노출되지 않는지도 확인했습니다.

### Trade-off

안전성을 얻는 대신 payment state machine과 운영 확인 절차가 복잡해졌습니다. 실제 운영에서는 `RECONCILE_REQUIRED` 적체를 감시하고 담당자에게 알리는 monitoring이 추가로 필요합니다.

### 관련 PR

- [PR #3 — Payment reconciliation](https://github.com/wlrjs1300-coder/ShoppingMall/pull/3)
- [PR #5 — Admin payment reconciliation UI](https://github.com/wlrjs1300-coder/ShoppingMall/pull/5)

## 2. Checkout order/payment 원자성

### 문제

다중 상품 주문에서는 order만 저장되고 item이나 payment가 누락되거나, 비회원 인증만 소비되고 주문 생성이 실패할 수 있습니다.

### 위험

- 금액과 상품 구성이 불완전한 주문이 생깁니다.
- 고객은 사용한 인증을 다시 쓸 수 없지만 주문도 갖지 못합니다.
- 재시도가 중복 주문과 payment link를 만들 수 있습니다.

### 선택

주문, 항목 snapshot, 상태 이력, checkout idempotency, 비회원 인증 소비와 payment row를 하나의 `BEGIN IMMEDIATE` transaction으로 묶었습니다.

### 구현

- 모든 상품을 활성 상태와 direct 구매 가능 여부로 다시 조회합니다.
- 상품 하나라도 유효하지 않으면 어떤 주문 row도 저장하지 않습니다.
- 가격과 상품명은 client가 아닌 DB를 기준으로 snapshot합니다.
- Checkout에는 유효한 `Idempotency-Key`를 필수로 요구하고 canonical request hash를 비교합니다.
- Payment link token은 random value를 반환하되 DB에는 hash와 만료 시각만 저장합니다.
- Replay 시 사용되거나 session이 생성된 링크를 다시 발급하지 않습니다.

### 검증

Payment insert 실패와 PII 암호화 실패를 강제로 발생시켜 order, items, history, verification consume이 모두 rollback되는지 확인했습니다. 판매 중지 상품, 가격 변경, 복수 상품, 같은 key의 동일·상이 payload와 반복 요청도 테스트했습니다.

### Trade-off

SQLite write transaction 안의 작업이 늘어 lock 보유 시간이 길어질 수 있습니다. 대신 provider 네트워크 호출은 transaction 밖 confirm 단계로 분리해 DB lock 중 외부 응답을 기다리지 않습니다.

### 관련 PR

- [PR #20 — Encrypted order writes](https://github.com/wlrjs1300-coder/ShoppingMall/pull/20)

## 3. Payment cancellation concurrency

### 문제

관리자 두 명, webhook 또는 재시도가 동시에 취소를 실행하면 provider에 중복 취소를 보내거나 부분 취소 합계가 원 결제 금액을 넘을 수 있습니다.

### 위험

- 이중 환불
- Provider 취소 이력과 local 잔액 불일치
- Provider 성공 후 DB 실패를 일반 오류로 처리하여 재취소

### 선택

취소 전에 조건부 상태 잠금을 획득하고 provider cancels 이력을 authoritative result로 사용했습니다.

### 구현

- `DONE` 또는 `PARTIAL_CANCELED` 상태에서 한 요청만 `CANCELING` lock을 획득합니다.
- 취소 금액, 잔액과 사유를 검증하고 provider idempotency key를 사용합니다.
- Provider 응답의 누적 cancels를 기준으로 전체·부분 취소 상태를 계산합니다.
- 명시적 거절이면 retry 가능한 이전 상태로 복구합니다.
- Timeout, 5xx 또는 provider 성공 후 local 반영 실패는 reconcile 대상으로 남깁니다.

### 검증

동시 취소가 provider를 한 번만 호출하는지, 잘못된 부분 취소가 provider와 local mock을 변경하지 않는지, 반복 webhook이 멱등인지, DB 후처리 실패가 재조정 상태로 남는지 검증했습니다.

### Trade-off

취소가 단순 상태 변경이 아니라 별도 state machine이 됐습니다. 그러나 provider와 local DB 사이에 분산 transaction이 없는 환경에서 결과를 추측하지 않는 편이 더 안전하다고 판단했습니다.

### 관련 PR

- [PR #4 — Payment cancellation safety](https://github.com/wlrjs1300-coder/ShoppingMall/pull/4)

## 4. 관리자 RBAC와 session revoke

### 문제

공유 `ADMIN_CODE`와 role claim만 신뢰하는 JWT는 담당자별 최소 권한, 퇴사자 접근 회수와 계정 상태 변경을 충분히 다루지 못합니다.

### 위험

- 모든 관리자가 결제 취소나 PII 수정 같은 고위험 기능에 접근합니다.
- 역할을 바꾸거나 계정을 비활성화해도 기존 token이 만료까지 유효할 수 있습니다.
- 마지막 최고 관리자를 실수로 제거해 운영 접근을 잃을 수 있습니다.

### 선택

DB 관리자 계정, 역할별 permission, issuer/audience가 있는 JWT와 token version을 도입했습니다.

### 구현

- 역할을 `super_admin`, `operations`, `finance`, `viewer`로 분리했습니다.
- Route는 `orders:*`, `payments:*`, `orders:pii:*` 같은 명시적 permission을 요구합니다.
- 요청마다 JWT뿐 아니라 DB의 현재 계정 활성 상태, role과 token version을 확인합니다.
- 비밀번호·역할·활성 상태 변경과 session revoke는 token version을 증가시킵니다.
- 마지막 활성 `super_admin`의 강등·비활성화를 차단합니다.
- 계정 변경과 감사 기록을 같은 transaction으로 저장합니다.

### 검증

역할별 API 접근표, 만료·issuer·audience·algorithm·token version 오류, inactive 계정, 동시 최고 관리자 강등, 감사 실패 rollback과 민감 필드 미노출을 테스트했습니다.

### Trade-off

요청마다 DB 계정 상태를 확인하는 비용과 계정 운영 절차가 추가됐습니다. 개인 프로젝트 규모에서는 즉시 회수 가능성과 단순성을 위해 이 비용을 수용했습니다.

### 관련 PR

- [PR #9 — Admin authentication and RBAC hardening](https://github.com/wlrjs1300-coder/ShoppingMall/pull/9)

## 5. PII 암호화와 점진적 전환

### 문제

주문 고객명, 전화번호와 배송 주소가 평문 column에 있었고, 기존 row를 유지하면서 신규 write를 암호화 형태로 전환해야 했습니다.

### 위험

- 한 번의 migration에서 대량 데이터를 수정하면 장애와 rollback 범위가 커집니다.
- Key rotation 없이 하나의 key에 고정되면 과거 ciphertext 운용이 어렵습니다.
- 손상된 ciphertext를 평문으로 fallback하면 보호 경계가 무너집니다.

### 선택

AES-256-GCM, versioned keyring, feature flag, encrypted/legacy read adapter와 별도 backfill CLI를 결합했습니다.

### 구현

- PII object를 canonical JSON으로 만들고 random IV로 암호화합니다.
- Ciphertext, IV, auth tag와 key version을 완전한 tuple로 저장하도록 DB 제약을 추가했습니다.
- Active key는 신규 write에, historical key는 기존 row decrypt에 사용합니다.
- 보호된 row의 평문 column은 placeholder/`NULL`로 바꾸고 마스킹 metadata만 일상 조회에 사용합니다.
- 암호화 row의 key 누락·부분 tuple·tag 오류는 legacy fallback 없이 fail-closed 처리합니다.
- Flag OFF 상태의 legacy contract와 flag ON 상태의 encrypted contract를 모두 테스트했습니다.

### 검증

Random IV로 동일 PII의 ciphertext가 달라지는지, tag 변조와 unknown version을 거부하는지, historical key decrypt와 active key rotation, keyring 입력 검증, 암호화/legacy 조회와 안전한 응답을 확인했습니다.

### Trade-off

전환 기간에는 legacy와 encrypted row를 모두 지원해야 합니다. 이를 감수하는 대신 코드 배포, 데이터 변환과 production flag 활성화를 분리해 장애 범위를 줄였습니다.

### 관련 PR

- [PR #16 — Order PII protection foundation](https://github.com/wlrjs1300-coder/ShoppingMall/pull/16)
- [PR #17 — Order PII read transition](https://github.com/wlrjs1300-coder/ShoppingMall/pull/17)
- [PR #20 — Order PII write encryption](https://github.com/wlrjs1300-coder/ShoppingMall/pull/20)

## 6. PII access/update audit

### 문제

암호화만으로는 정상 권한을 가진 관리자가 필요 이상으로 PII를 열람하거나 수정하는 문제를 해결할 수 없습니다. 일반 주문 조회·수정 API에 PII를 포함하면 목록, cache와 export로 확산될 수 있습니다.

### 위험

- 업무 목적 없는 열람
- PII가 관리자 목록·전역 상태·CSV에 잔류
- 수정과 감사 로그가 따로 commit되어 추적 불가능한 변경 발생
- 감사 시스템 장애 시 보호값이 그대로 응답

### 선택

일반 주문 API와 PII read/write endpoint를 분리하고, 별도 permission·사유·rate limit·원자적 감사를 적용했습니다.

### 구현

- 일반 관리자 목록과 고객 directory는 모든 역할에 마스킹 값만 반환합니다.
- `orders:pii:read`는 허용된 업무 사유를 요구하고 dialog 범위에서만 값을 보여줍니다.
- `orders:pii:write`는 `super_admin`만 가지며 변경 필드와 사유를 기록합니다.
- 읽기와 쓰기에 서로 다른 사용자별 rate limit을 적용합니다.
- PII 응답은 `Cache-Control: no-store`이며 UI cache·export에 넣지 않습니다.
- 성공·실패 audit에 actor, role, order, reason, outcome과 안전한 metadata만 기록합니다.
- 감사 저장 실패 시 열람을 반환하지 않고 수정 transaction도 rollback합니다.

### 검증

권한·사유 오류, rate limit, 암호화 손상, audit insert 실패, stale update, no-op/unknown field, 일반 PUT을 통한 PII 우회와 UI cache·export 유출을 테스트했습니다.

### Trade-off

배송·고객 응대 업무에 한 단계의 사유 선택이 추가됩니다. 개인정보 열람을 예외적이고 추적 가능한 작업으로 만들기 위한 의도적인 마찰입니다.

### 관련 PR

- [PR #18 — Admin order PII access](https://github.com/wlrjs1300-coder/ShoppingMall/pull/18)
- [PR #19 — Admin order PII update](https://github.com/wlrjs1300-coder/ShoppingMall/pull/19)

## 7. Backup and recovery

### 문제

SQLite를 container의 임시 filesystem에 두면 재배포나 장애 시 데이터가 유실될 수 있습니다. 단순 파일 복사는 WAL 사용 중 일관된 snapshot을 보장하지 않으며, backup 파일이 존재한다는 사실만으로 복구 가능성을 증명할 수 없습니다.

### 위험

- 불완전하거나 손상된 snapshot
- DB와 같은 장애 영역에 backup 저장
- 검증되지 않은 파일로 운영 DB를 덮어쓰기
- 고객 데이터와 source path가 metadata·로그에 노출

### 선택

외부 경로의 SQLite online backup, checksum, 격리 검증과 승인된 수동 restore를 채택했습니다.

### 구현

- Node SQLite backup API로 실행 중인 DB의 snapshot을 만듭니다.
- 임시 파일을 검증한 뒤 DB, checksum, 최소 metadata를 atomic하게 확정합니다.
- 검증은 checksum, SQLite integrity, foreign key, 필수 테이블과 주요 조회를 포함합니다.
- 성공한 backup 이후에만 완전한 오래된 세트에 retention을 적용합니다.
- 알 수 없는 파일, 불완전한 세트와 생성 중 파일은 자동 삭제하지 않습니다.
- Backup 경로 traversal과 외부 파일 지정을 차단합니다.
- 자동 restore command와 HTTP restore route를 제공하지 않습니다.

### 검증

Snapshot 생성, checksum/metadata 변조, malformed checksum, invalid SQLite, missing table, FK 위반, traversal, retention과 임시 artifact 정리를 테스트했습니다. Backup에 PII 암호화 column은 보존되지만 keyring secret은 포함되지 않는지도 확인했습니다.

### Trade-off

자동 복구보다 안전 경계를 우선하여 RTO가 길어질 수 있습니다. 반복적인 staging restore rehearsal로 절차가 안정된 뒤 승인과 제한이 있는 자동화를 검토할 수 있습니다.

### 관련 PR

- [PR #8 — External backup and recovery](https://github.com/wlrjs1300-coder/ShoppingMall/pull/8)

## 8. One-off backfill/purge CLI

### 문제

기존 주문 PII를 암호화하고 payment 테이블에 중복 저장된 이름·전화번호를 제거해야 하지만, 이 작업을 schema migration이나 server startup에서 실행하면 배포 자체가 장시간 mutation과 결합됩니다.

### 위험

- 예상치 못한 대량 write와 lock
- 부분 실패 후 어떤 batch까지 반영됐는지 불명확
- 두 운영자가 같은 작업을 동시에 실행
- 손상 row나 unknown key가 있는 상태에서 일부만 변환
- Report와 로그에 PII 포함

### 선택

Backfill과 purge를 각각 독립된 one-off CLI로 구현하고 `dry-run`, `apply`, `verify` 단계를 강제했습니다.

### 구현

- Row를 encrypted, legacy valid/invalid, partial, unknown key, connected/orphan 등으로 분류합니다.
- Blocker가 있으면 mutation 전에 중단합니다.
- Stable ID 순서와 batch 범위로 재실행 가능한 pagination을 사용합니다.
- 각 batch는 `BEGIN IMMEDIATE`, compare-and-update와 bounded busy retry를 사용합니다.
- Process lock은 중복 runner를 막고 owner token과 PID를 확인해 안전한 stale takeover만 허용합니다.
- Report는 allowlist field만 atomic하게 기록하고 기존 파일 overwrite를 거부합니다.
- Verify는 첫 batch뿐 아니라 전체 테이블을 검사합니다.
- Production apply에는 명시적인 확인 인자를 추가로 요구합니다.

### 검증

재실행 멱등성, batch rollback과 이전 batch 보존, concurrent mutation, busy retry, duplicate/stale lock, unknown key, invalid legacy 승인, orphan payment와 safe report를 테스트했습니다.

### Trade-off

자동 migration보다 운영자 단계가 많지만 backup, write freeze, dry-run 결과와 승인 gate를 독립적으로 확인할 수 있습니다. 실제 execution은 production 활성화 runbook에 따라 별도로 수행해야 하며 저장소에 도구가 있다는 사실만으로 수행 완료를 의미하지 않습니다.

### 관련 PR

- [PR #21 — Order PII backfill CLI](https://github.com/wlrjs1300-coder/ShoppingMall/pull/21)
- [PR #22 — Payment PII purge CLI](https://github.com/wlrjs1300-coder/ShoppingMall/pull/22)
- [PR #23 — PII production activation runbook](https://github.com/wlrjs1300-coder/ShoppingMall/pull/23)

## 검증 범위와 현재 상태

2026-08-03 기준 전체 `node:test` suite를 다시 실행해 **516 passed, 0 failed, 0 skipped**를 확인했습니다. Coverage 백분율은 측정하지 않았습니다.

이 사례들의 구현과 자동 테스트는 완료됐고 production 수행을 위한 절차도 준비돼 있습니다. 다만 실제 운영 DB의 backup/restore rehearsal, 실제 데이터 backfill/purge, production keyring 활성화, 실 provider credential 검증과 monitoring은 아직 수행 완료로 주장하지 않습니다.
