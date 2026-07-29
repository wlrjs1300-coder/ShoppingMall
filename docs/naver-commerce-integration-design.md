### 네이버 스마트스토어 커머스API 연동 설계

문서 기준일: 2026-07-29
설계 단계: Phase N0
구현 상태: 설계만 완료. API 호출, migration, scheduler, UI, 환경변수 변경은 하지 않음.

### 1. 목적과 범위

이 문서는 현재 ShoppingMall의 상품·주문·결제·재고·관리자 구조와 네이버 커머스API 계약을 비교하고, 구현 전에 데이터 경계와 동기화 정책을 확정한다. 네이버 식별자를 내부 PK로 재사용하지 않으며 외부 원본 수집, 내부 변환, 재고 반영을 분리한다.

공식 근거는 다음 자료로 제한한다.

- [네이버 커머스API 최신 문서(v2.83.0, 2026-07-21)](https://apicenter.commerce.naver.com/docs/commerce-api/current)
- [공식 LLM 문서 인덱스](https://apicenter.commerce.naver.com/llms/llms.txt)
- [공식 인증 문서](https://apicenter.commerce.naver.com/docs/auth)
- [공식 제약 사항](https://apicenter.commerce.naver.com/docs/restriction)
- [공식 문제 해결](https://apicenter.commerce.naver.com/docs/trouble-shooting)
- [공식 기술지원·릴리즈 노트 저장소](https://github.com/commerce-api-naver/commerce-api)

문서 작성 시점 이후 API 변경은 구현 착수 때 릴리즈 노트와 최신 OpenAPI 문서로 다시 확인한다.

### 2. 현재 내부 구조

조사 근거는 `server/db.js`, `server/migrations.js`, `server/data/products.js`, 주문·결제·재고 route 및 관련 test다.

### 상품과 옵션

- `products.id`는 TEXT PK이며 사람이 읽을 수 있는 영문 kebab-case slug다. 예: `injeolmi`, `black-sesame-injeolmi`, `gift-box`.
- 현재 30개 상품은 명시적 seed이며 자동 생성 규칙은 없다.
- `purchase_type`은 `direct` 또는 `consultation`이다. direct 25개는 정수 가격이 필수이고 consultation 5개는 가격이 `NULL`이어야 한다.
- 상품에는 `name`, `category`, `price`, `image_url`, `description`, `status(active/inactive)`, `display_order`가 있다.
- variant/option/SKU 테이블과 variant별 가격·재고는 없다. 주문 항목에도 옵션 ID가 없다.
- 내부 ID는 현재 ASCII slug지만 형식·길이를 DB 제약으로 고정하지 않았으므로 외부 판매자 관리 코드로 직접 노출하지 않는다.

### 재고와 생산

- `inventory`는 완제품이 아니라 원재료 원장이다. 필드는 `id`, `name`, `stock REAL`, `unit`, `safe_stock`, `memo`다.
- `recipes`는 `(product, ingredient)` 복합 PK이며 상품명과 원재료명을 문자열로 연결한다. `products.id` FK가 아니다.
- 주문 생성이나 결제 완료 시 원재료가 차감되지 않는다.
- 관리자가 생산 완료를 실행할 때 recipe 소요량을 검증한 후 `BEGIN IMMEDIATE` 트랜잭션에서 원재료와 `inventory_logs`를 함께 반영한다.
- 예약 재고, 완제품 가용 재고, 채널별 할당량이 없다. 따라서 현재 원재료 수량을 네이버 판매 재고로 직접 변환할 수 없다.
- 주문 취소 시 이미 차감한 원재료를 자동 복구하는 일반 정책이 없다. 생산 완료 이후 취소는 별도 운영 판단이 필요하다.

### 주문과 주문 항목

- `orders.id`는 route에서 UUID 기반으로 생성되는 내부 TEXT PK다.
- 회원 주문은 `user_id`가 있고 비회원 주문은 `NULL`이다. 고객명·전화번호는 주문 snapshot으로 저장된다.
- `fulfillment_type`은 `pickup` 또는 `delivery`; 주소, 희망일·시간, 배송/픽업 logistics 상태를 보유한다.
- `order_items`는 상품명·단가·수량·합계를 snapshot으로 저장하며 `product_id`는 nullable FK다.
- 한 checkout은 내부 order 하나와 여러 order_items로 저장된다.
- 외부 채널, 외부 주문번호, 외부 상품주문번호, 옵션 ID를 담을 기존 컬럼은 없다.
- `order_idempotency`와 `checkout_idempotency`가 요청 hash와 키를 저장해 자체몰 중복 주문을 막는다.
- `order_status_history`는 주문 수준 상태 이력만 제공한다. 상품주문별 상태·클레임 이력은 없다.

### 상태, 결제, 취소

- 레거시 `status`: 접수대기, 준비중, 준비완료, 픽업완료, 배송중, 배송완료, 취소, 주문취소.
- `workflow_status`: 결제대기 → 접수대기 → 접수완료 → 배송중/픽업준비완료 → 배송완료/픽업완료 또는 취소.
- `payment_status`: 결제대기, 결제완료, 부분환불, 결제취소, 환불완료.
- `payments`는 `order_id UNIQUE`인 Toss 중심 모델이며 payment key, confirm/cancel idempotency key와 provider 조정 상태를 가진다.
- 부분 금액 취소는 존재하지만 내부 order_items별 부분 수량 클레임 상태 모델은 없다.
- 외부 네이버 결제는 Toss 승인·취소·재조정 흐름에 넣을 수 없다.

### 감사, RBAC, 운영

- `activity_logs`는 category/message/tab에 더해 migration으로 action, entity, 이전/다음 값, actor를 기록한다.
- 현재 permission은 orders, inventory, purchase orders, payments, activity logs, admin users, backup 범위다. sales channel 권한은 없다.
- 운영은 SQLite 단일 writer, WAL, 외부 원자적 백업·검증, 수동 복원 정책을 사용한다.

### 3. 네이버 공식 API 계약

Base URL은 `https://api.commerce.naver.com/external`이다. OAuth 2.0 Client Credentials bearer token을 사용한다.

### 인증

- `POST /v1/oauth2/token`
- `application/x-www-form-urlencoded`
- 필수: `client_id`, 5분 유효 millisecond `timestamp`, `grant_type=client_credentials`, 전자서명 `client_secret_sign`, `type`.
- 판매자 리소스 토큰은 `type=SELLER`일 때 `account_id`가 필요하다.
- 토큰 유효시간은 3시간(10,800초). 잔여 30분 이상이면 기존 토큰, 미만이면 새 토큰이 반환될 수 있다.
- `401`과 `GW.AUTHN`에 한해 토큰을 폐기·재발급하고 원 요청은 한 번만 재시도한다.

### 상품

- `POST /v1/products/search`: `CHANNEL_PRODUCT_NO`, `PRODUCT_NO`, `GROUP_PRODUCT_NO`, `SELLER_CODE` 검색 및 page/size 결과.
- `GET /v2/products/origin-products/{originProductNo}`: 현재 원상품 단건 조회.
- `GET /v2/products/channel-products/{channelProductNo}`: 현재 채널상품 단건 조회.
- `PUT /v1/products/origin-products/{originProductNo}/option-stock`: 옵션 재고·가격·할인가 변경. 동일 원상품 호출은 내부에서 직렬화한다.
- `PUT /v1/products/origin-products/{originProductNo}/change-status`: `SALE`, `OUTOFSTOCK`, `SUSPENSION`. 재고 0의 품절과 정책적 판매중지를 별도로 다룬다.
- 옵션 식별자는 종류에 따라 조합형 `optionCombinationId`, 표준형 `optionStandardId`, 단독형 `optionSimpleIds`로 다르다. 이름 문자열로 매핑하지 않는다.
- 판매자 관리 코드의 정확한 허용 문자·길이는 현재 확인한 공식 조회 문서에 명시가 없어 구현 직전 상품 등록/수정 schema 원문으로 재확인한다.

### 주문과 클레임

- `GET /v1/pay-order/seller/product-orders/last-changed-statuses`: 변경 시각 오름차순 feed. 한 응답 최대 300개(또는 `limitCount`), `more.moreFrom`과 `more.moreSequence`로 계속 조회한다. 종료시각 생략 시 시작부터 24시간 범위다.
- `POST /v1/pay-order/seller/product-orders/query`: `productOrderIds` 최대 300개. 수량 클레임 대응 시 `quantityClaimCompatibility=true` 사용 여부를 N6 전에 검증한다.
- `GET /v1/pay-order/seller/orders/{orderId}/product-order-ids`: 한 주문의 상품주문 ID 목록.
- `GET /v1/pay-order/seller/product-orders`: 조건형 상세 snapshot 조회.
- `POST /v1/pay-order/seller/product-orders/confirm`: 발주 확인.
- `POST /v1/pay-order/seller/product-orders/dispatch`: 발송 처리.
- 취소 승인/요청, 반품 요청·승인·보류·해제·철회, 교환 수거·재배송·보류·해제·철회 API가 상품주문 단위로 존재한다. N6 전에는 호출하지 않는다.

상세의 핵심 상태는 `productOrderStatus`의 `PAYMENT_WAITING`, `PAYED`, `DELIVERING`, `DELIVERED`, `PURCHASE_DECIDED`, `EXCHANGED`, `CANCELED`, `RETURNED`, `CANCELED_BY_NOPAYMENT`이며, `claimStatus`는 `CANCEL_REQUEST`, `CANCELING`, `CANCEL_DONE`, `CANCEL_REJECT`, `RETURN_REQUEST`, `EXCHANGE_REQUEST`, `COLLECTING`, `COLLECT_DONE`, `EXCHANGE_REDELIVERING`, `RETURN_DONE`, `EXCHANGE_DONE`, `RETURN_REJECT`, `EXCHANGE_REJECT`, 구매확정 보류 계열, 직권취소 계열을 포함한다. 변경 feed의 `lastChangedType` 전체 목록은 [공식 변경 상품주문 문서](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-last-changed-status-pay-order-seller)를 구현 시점에 enum과 함께 고정한다.

### 호출 제한과 오류

- TLS 1.2 이상 및 등록한 API 권한 그룹이 필요하다.
- rate limit은 API·application 단위 token bucket이며 고정 숫자는 정책에 따라 유동적이다. 응답의 `GNCP-GW-RateLimit-Replenish-Rate`, `Burst-Capacity`, `Remaining`을 관찰한다.
- 초과는 `429 GW.RATE_LIMIT` 또는 `GW.QUOTA_LIMIT`이다. 공식 문서에 모든 API 공통 `Retry-After` 보장은 확인되지 않았으므로 있으면 존중하고 없으면 jitter 포함 지수 백오프를 적용한다.
- trace는 `GNCP-GW-Trace-ID` 헤더 또는 오류 body의 `traceId`를 저장한다.
- 401 인증, 403 IP/권한, 429 제한, 5xx/503/504 일시 장애를 구분한다.
- 최신 공식 문서 버전과 릴리즈 노트를 N1 착수와 매 배포 전에 확인한다.

### 4. 연동 원칙

1. 내부와 외부 식별자를 분리한다.
2. 외부 원본 수집과 내부 주문 생성을 별도 트랜잭션·상태로 둔다.
3. 외부 상태 원문을 보존하고 versioned mapper를 통과시킨다.
4. 미매핑·미지원 상태는 저장하되 결제·재고를 자동 변경하지 않는다.
5. 네이버 결제를 Toss로 처리하지 않는다.
6. 자체몰을 재고 원장으로 하되 완제품 가용량 모델이 생기기 전에는 자동 push를 끈다.
7. 삭제 대신 매핑 비활성화와 감사 이력을 사용한다.
8. 모든 동기화는 반복 실행 가능하고 상태 후퇴·중복 차감을 금지한다.

### 5. 상품·옵션 매핑

제안 테이블 `sales_channel_product_mappings`:

```text
id, channel, internal_product_id, internal_variant_id NULL,
external_origin_product_no, external_channel_product_no,
external_group_product_no NULL, external_option_type NULL,
external_option_id NULL, external_simple_option_ids_json NULL,
seller_management_code, sync_status,
inventory_sync_enabled, price_sync_enabled, safety_stock,
last_pushed_stock, last_confirmed_external_stock,
last_product_sync_at, last_inventory_sync_at,
last_error_code, last_error_summary, created_at, updated_at
```

권장 제약:

- `UNIQUE(channel, external_channel_product_no)`
- 옵션 ID가 있으면 `UNIQUE(channel, external_origin_product_no, external_option_type, external_option_id)`
- 내부 단일 상품 매핑은 `UNIQUE(channel, internal_product_id)`; variant 도입 후 `(channel, internal_product_id, internal_variant_id)`로 확장
- 외부 번호는 TEXT로 저장해 JavaScript 정수 정밀도 문제와 계약 변화에 대비
- `last_error_summary`에는 secret, token, 주문 개인정보, provider 원문을 저장하지 않음

판매자 관리 코드는 외부 조회 보조키일 뿐 유일한 진실 원장이 아니다. `SM-` + 내부 ID의 정규화된 불변 코드 사용을 검토하되 공식 허용 문자·길이 확인 전 생성 규칙을 확정하지 않는다. 한글·공백·특수문자나 향후 ID 변경에 대비해 DB에 한번 생성된 값을 불변으로 저장한다.

옵션 없는 상품은 `internal_variant_id`, `external_option_*`가 모두 NULL인 원상품/채널상품 매핑으로 표현한다. 현재 variant가 없으므로 N2 첫 범위는 옵션 없는 direct 상품만이다. consultation, 예약, 맞춤 상품은 기본 `inventory_sync_enabled=false`, 자동 주문 변환 제외다.

### 내부·네이버 식별자 매핑표

| 내부 개념 | 내부 필드 | 네이버 개념 | 네이버 필드 | 저장 위치 |
|---|---|---|---|---|
| 상품 | `products.id` | 원상품 | `originalProductId` / `originProductNo` | product mappings |
| 상품 | `products.id` | 채널상품 | `productId` / `channelProductNo` | product mappings |
| 그룹 없음 | 없음 | 그룹상품 | `groupProductId` / `groupProductNo` | product mappings nullable |
| variant 없음 | 향후 `internal_variant_id` | 조합형 옵션 | `optionCombinationId` | product mappings |
| variant 없음 | 향후 `internal_variant_id` | 표준형 옵션 | `optionStandardId` | product mappings |
| variant 없음 | 향후 `internal_variant_id` | 단독형 옵션 | `optionSimpleIds` | product mappings JSON |
| 내부 관리 코드 | 별도 불변값 | 판매자 관리 코드 | `sellerManagementCode` / `sellerProductCode` | product mappings |
| 주문 | `orders.id` | 주문 | `orderId` | channel orders |
| 주문항목 | `order_items.id` | 상품주문 | `productOrderId` | channel order items |
| 채널 결제 | 별도 외부 결제 모델 | 네이버 결제 snapshot | order payment fields | channel orders/payment extension |

### 6. 주문 데이터 모델

권고는 안 A, 즉 네이버 `orderId` 하나를 내부 `orders` 하나로 만들고 각 `productOrderId`를 `order_items`에 연결하는 방식이다. 현재 내부 checkout도 order 1:N items이며 공통 배송지·결제 합계를 갖는다.

단, 네이버 클레임은 상품주문 단위이므로 N4 전에 `sales_channel_order_items`에 독립 상태·잔여수량·클레임을 두고, 내부 `order_items`에 외부 상태를 억지로 넣지 않는다. 서로 다른 배송지/이행 방식 또는 내부 정책상 함께 처리할 수 없는 상품주문이 발견되면 deterministic split key로 내부 order를 여러 개 만들 수 있게 `sales_channel_orders`와 `internal_order_id`를 1:N 연결 테이블로 확장한다.

제안 최소 모델:

```text
sales_channel_orders
  id, channel, external_order_id, import_status,
  external_order_status, external_payment_status, mapping_version,
  ordered_at, paid_at, buyer_name_masked,
  recipient_name_encrypted, recipient_phone_encrypted,
  postal_code, address_encrypted, address_detail_encrypted,
  source_updated_at, payload_hash,
  redacted_payload, first_imported_at, last_imported_at,
  created_at, updated_at

sales_channel_order_items
  id, channel_order_id, external_product_order_id,
  internal_order_id NULL, internal_order_item_id NULL,
  internal_product_id NULL, internal_variant_id NULL,
  external_product_no, external_origin_product_no, external_option_id NULL,
  product_name_snapshot, option_name_snapshot,
  initial_quantity, remaining_quantity, unit_price,
  discount_amount, line_total,
  external_status, external_claim_status, source_updated_at,
  mapping_version, created_at, updated_at

sales_channel_sync_events
  id, channel, event_type, external_resource_id,
  source_updated_at, idempotency_key, payload_hash,
  status, attempt_count, next_retry_at,
  last_error_code, last_error_summary, provider_trace_id,
  started_at, completed_at, created_at, updated_at

sales_channel_import_links
  channel_order_id, internal_order_id, split_key, created_at
```

상태: `PENDING_MAPPING`, `READY_TO_IMPORT`, `IMPORTED`, `RETRY_PENDING`, `FAILED`, `MANUAL_REVIEW`, `IGNORED`.

### 7. 주문 수집 흐름

```text
변경 feed 조회
→ productOrderId와 source changed time 저장
→ 중복 제거
→ 최대 300개 상세 batch 조회
→ schema·식별자 검증
→ 개인정보 최소화/redaction
→ channel order/item upsert
→ mapping·상태 mapper 평가
→ N3에서는 종료
→ N4에서 내부 order 변환
→ sync event 완료와 cursor commit
```

초기 동기화:

- 운영 개시 기준일은 기본 30일 전을 제안하지만 공식 조회 가능 기간과 실제 주문량을 N3 착수 시 확인한 뒤 운영자가 승인한다.
- 작은 시간 창으로 분할하고 feed의 `moreFrom/moreSequence`를 끝까지 소비한다.
- dry run에서 미매핑률과 개인정보 저장 범위를 검토한 후 import를 승인한다.
- 동일 기간 재실행이 안전해야 한다.

증분 동기화:

- 권장 poll은 2분, 공식 문서 권장 1~3분 범위 안이다. 실제 제한 헤더와 지연 지표로 조정한다.
- 마지막 성공 watermark보다 10분 이전부터 overlap 조회한다.
- `last_attempt_at`과 `last_successful_watermark`를 분리한다.
- 동일 timestamp의 순서는 `moreSequence`까지 cursor에 포함한다.
- 상세 일부 실패 시 성공 건은 upsert할 수 있지만 안전한 watermark 이전 실패가 남으면 cursor를 넘기지 않는다.
- 오래된 snapshot은 `source_updated_at`과 상태 전이 규칙으로 무시한다.

### API 사용 계획

| 목적 | 공식 API | 방식 | 주기 | 멱등성 키 | 실패 처리 |
|---|---|---|---|---|---|
| 토큰 | `POST /v1/oauth2/token` | cached bearer | 만료 전 필요 시 | account/type cache key | 401 한 번 재발급 |
| 상품 탐색 | `POST /v1/products/search` | paged read | 수동·일일 감사 | channel+external product | 429/5xx 제한 재시도 |
| 상품 검증 | v2 origin/channel GET | 단건 read | 매핑 변경 시 | external product no | 미존재는 manual review |
| 변경 주문 | last-changed-statuses GET | cursor poll | 권장 2분 | productOrderId+changed time | cursor 보류 |
| 주문 상세 | query POST | 최대 300 batch | 변경 수집 직후 | productOrderId+source time | batch 분할 재시도 |
| 발주/발송 | confirm/dispatch POST | N7 이후 write | 운영 이벤트 | command id | 결과 feed 재검증 |
| 재고 push | option-stock PUT | 원상품별 직렬화 | N5, 5~15분 후보 | mapping+stock version | drift/재시도 |
| 판매상태 | change-status PUT | 명시적 정책 command | 필요 시 | mapping+desired state | SUSPENSION 보호 |
| 클레임 | 상품주문별 claim API | N6 이후 승인형 | 이벤트 | claimId+command | 자동 반복 금지 |

### 8. 상태 매핑

외부 상태와 클레임 상태를 원문으로 저장하고 `mapping_version`이 있는 순수 변환 계층에서 내부 상태를 계산한다. 네이버 변경 유형과 상세 현재 상태가 충돌하면 상세 snapshot을 기준으로 하되 이벤트는 감사용으로 보존한다.

### 주문 상태 매핑 초안

| 네이버 상태 | 내부 상태 | 자동 처리 | 재고 영향 | 관리자 확인 |
|---|---|---|---|---|
| `PAYMENT_WAITING` | 결제대기 | snapshot 저장 | 없음 | 아니요 |
| `PAYED` | 접수대기 후보 | N4에서 import | 예약/차감 정책 적용 | 매핑 누락 시 필요 |
| 발주 `NOT_YET` | 접수대기 | 외부 상태만 저장 | 중복 차감 없음 | 발주 자동화 전 필요 |
| 발주 `OK` | 접수완료 후보 | N7 전 읽기 전용 | 차감 확정 후보 | 정책 승인 필요 |
| `DELIVERING` | 배송중 | 최신일 때 전진 | 없음 | 아니요 |
| `DELIVERED` | 배송완료 | 최신일 때 전진 | 없음 | 아니요 |
| `PURCHASE_DECIDED` | 배송완료/완료 snapshot | 외부 확정 기록 | 없음 | 정산 연계 시 필요 |
| `CANCELED_BY_NOPAYMENT` | 취소 | 내부 미생성 또는 취소 | 예약분만 복구 | 생산 후면 필요 |
| `CANCELED` | 취소 | item claim 저장 | 자동 복구 금지 | 부분/생산 후 필요 |
| `RETURNED` | 기존 상태 유지+claim | 자동 내부 환불 금지 | 자동 복구 금지 | 예 |
| `EXCHANGED` | 기존 상태 유지+claim | 자동 교체 금지 | 자동 변경 금지 | 예 |
| `CANCEL_REQUEST` | 기존 상태 유지 | 요청 표시 | 없음 | 예 |
| `COLLECTING/COLLECT_DONE` | 기존 상태 유지 | 수거 표시 | 자동 복구 금지 | 예 |
| `EXCHANGE_REDELIVERING` | 기존 상태 유지 | 재배송 표시 | 자동 변경 금지 | 예 |
| 미지원/신규 enum | 변경 없음 | `MANUAL_REVIEW` | 없음 | 예 |

상태 후퇴는 금지하되 취소·반품·교환은 선형 workflow와 별도 claim state machine으로 처리한다. mapping version 변경은 dry run 후 명시적 재평가 작업으로만 적용한다.

### 9. 재고 동기화

비교:

- A 자체몰 원장 → 네이버 push: 충돌면이 작고 내부 생산·주문과 연결 가능하다.
- B 네이버 원장 → 자체몰 pull: 현재 원재료 기반 내부 원장과 의미가 맞지 않는다.
- C 양방향: 수동 변경과 동시 주문 충돌 해결 규칙이 없어 1차에 부적합하다.

결정은 A지만 N5 전제조건으로 완제품 가용량/예약량 모델을 먼저 만든다. 현재 원재료 stock이나 `recipes`만으로 판매 가능 수량을 자동 계산하지 않는다.

권장 계산:

```text
external_available_stock =
max(0, finished_goods_available - reserved_quantity - safety_stock)
```

- 상품별 `safety_stock`, sync enable, last pushed/confirmed 값을 둔다.
- 기본 safety stock은 1을 후보로 하되 판매속도·생산 lead time을 보고 운영자가 상품별 승인한다.
- 원상품별 push를 직렬화하고 version/CAS로 오래된 계산 결과가 최신 결과를 덮지 못하게 한다.
- `stock=0` 품절과 정책 `SUSPENSION`을 분리한다. 재고 회복으로 SUSPENSION을 SALE로 자동 변경하지 않는다.
- 스마트스토어센터 수동 재고 변경은 원칙적으로 금지한다. 불가피한 변경은 drift로 탐지하고 자체몰에 자동 pull하지 않으며 관리자 승인 후 자체 원장 또는 재push 중 하나를 선택한다.
- consultation·예약·맞춤 상품은 자동 동기화 제외다.

재고 차감 후보:

1. `PAYED` 즉시 차감: 초과판매 방지에 강하지만 취소 복구와 현재 생산 차감과 이중 반영 위험.
2. reserved quantity 추가: 가용량은 즉시 줄이고 실재고는 생산 완료 때 차감. 가장 정확하지만 schema·로직 추가 필요.
3. 관리자 승인 전 미차감: 구현은 단순하지만 초과판매 위험.

권고는 2번이다. N4에서 `PAYED` 수집 시 예약하고, 발주 확인/내부 접수 확정으로 예약을 유지하며 기존 생산 완료에서 원재료를 실제 차감한다. 취소 완료는 아직 생산하지 않은 예약만 원자적으로 해제한다. 예약 모델 전까지 N3은 내부 주문·재고를 변경하지 않는다.

가격 자동 동기화는 N0~N5에서 제외한다. 네이버 할인·쿠폰·옵션가·배송비·정산과 내부 정가를 분리한다.

### 10. 결제 처리

- 네이버 주문은 `payment_provider=naverpay`, `payment_source=sales_channel` 의미의 별도 채널 결제 snapshot으로 취급한다.
- 기존 `payments`는 Toss payment key와 provider 명령을 전제로 하므로 그대로 재사용하지 않는다.
- 네이버 결제 금액, 할인, 배송비, 잔여 금액은 외부 snapshot으로 저장하고 내부 order 합계와 검증한다.
- import 과정에서 Toss confirm/cancel/reconcile API를 절대 호출하지 않는다.
- 불일치는 `MANUAL_REVIEW`이며 자동 금액 보정·환불을 하지 않는다.

### 11. 취소·반품·교환

현재 내부 시스템은 주문 전체 취소와 결제 부분 금액 취소는 있지만 상품주문별·부분 수량 claim workflow가 없다.

N3~N5 정책:

- 주문 전체/상품주문 일부/수량 일부 취소, 반품, 교환, 철회를 외부 item claim으로 분리 저장한다.
- `initialQuantity`와 `remainQuantity`, claim ID/type/status를 보존한다.
- 관리자 검토 queue에 표시한다.
- 자동 환불, Toss 호출, 재고 복구, 네이버 claim write API 호출을 금지한다.
- 생산 전 예약 해제처럼 안전성이 증명된 처리만 N6에서 별도 승인한다.

N6에서 수량 클레임 계약과 `quantityClaimCompatibility=true` 대응, item 단위 내부 상태, 보상 트랜잭션, 네이버 명령 후 feed 재검증을 완료한 뒤 자동화 범위를 결정한다.

### 12. 멱등성과 동시성

권장 UNIQUE:

- `sales_channel_orders(channel, external_order_id)`
- `sales_channel_order_items(channel, external_product_order_id)`
- `sales_channel_sync_events(channel, event_type, external_resource_id, source_updated_at)`
- internal import link에서 `(channel_order_id, internal_order_id)`

처리 규칙:

- payload를 정규화·redact한 뒤 hash를 계산한다. 같은 source time/hash는 no-op으로 기록한다.
- source time이 같고 hash가 다르면 자동 덮어쓰지 않고 `DB_CONFLICT`.
- SQLite write는 짧은 `BEGIN IMMEDIATE`로 event claim, upsert, import link, inventory reservation, audit를 원자화한다.
- event worker는 `PENDING/RETRY_PENDING → RUNNING` 조건부 update로 소유권을 획득한다.
- 내부 order id는 channel과 external order/split key에서 deterministic하게 생성하거나 import link의 UNIQUE를 선점한다.
- 상태 version과 source time을 비교해 과거 snapshot의 후퇴를 금지한다.
- 재고 reservation ledger에 외부 productOrderId 기반 UNIQUE를 둬 중복 차감·복구를 막는다.
- 활동 로그는 business transition ID를 UNIQUE reference로 사용해 poll마다 중복 생성하지 않는다.

### 13. 실패 재처리

| 오류 | 자동 재시도 | 정책 |
|---|---|---|
| `AUTH_ERROR` | 제한적 | token 폐기·1회 재발급, 반복 시 동기화 정지·알림 |
| `RATE_LIMIT` | 예 | 제한 헤더/Retry-After가 있으면 준수, 아니면 jitter backoff |
| `NETWORK_ERROR` | 예 | timeout 포함 제한 횟수 |
| `NAVER_SERVER_ERROR` | 예 | 5xx/503/504 지수 백오프 |
| `INVALID_RESPONSE` | 아니요 | payload 최소 격리, manual review |
| `PRODUCT_MAPPING_MISSING` | 아니요 | PENDING_MAPPING, 매핑 후 명시적 재처리 |
| `STATUS_MAPPING_MISSING` | 아니요 | 원문 보존, mapper 업데이트 대기 |
| `DB_CONFLICT` | 제한적 | 최신 row 재조회 후 한 번, 이후 수동 |
| `BUSINESS_RULE_REJECTED` | 아니요 | 사유 코드와 관리자 조치 표시 |

attempt count, next retry, safe summary, provider trace ID만 저장한다. 오류 body 전체, 주소, 전화, token, secret은 로그·event error에 저장하지 않는다. dead-letter 상태에서 운영자가 범위와 결과를 확인한 후 재처리한다.

### 14. 개인정보와 보안

기본 정책은 필요한 필드 정규화 + 개인정보가 제거된 최소 redacted payload + 제한 보존이다. 원 응답 전체의 평문 영구 저장은 금지한다. 암호화 raw payload는 초기 장애 분석에서 필요성이 입증되고 키관리·삭제 작업이 준비된 경우에만 별도 승인을 받는다.

### 데이터 저장 정책

| 데이터 | 저장 여부 | 마스킹 | 암호화 | 보존 기간 | 목적 |
|---|---|---|---|---|---|
| orderId/productOrderId | 예 | 아니요 | at-rest 권장 | 거래·법정 보존 정책 | 식별·멱등 |
| 주문자 이름 | 마스킹본만 | 예 | 원문 미저장 | 주문 운영기간 | 고객 확인 보조 |
| 주문자 연락처 | 기본 미저장 | 예 | 원문 미저장 | 없음 | 수령인 정보로 대체 |
| 구매자 ID/번호 | 기본 미저장 | 예 | 원문 미저장 | 없음 | 목적 불충분 |
| 수령인 이름 | 예 | 화면 마스킹 | 예 | 배송 완료 후 정책 기간 | 이행 |
| 수령인 연락처 | 예 | 화면·로그 마스킹 | 예 | 배송 완료 후 정책 기간 | 배송 연락 |
| 주소·상세주소 | 배송일 때 예 | 화면 부분 마스킹 | 예 | 배송 완료 후 정책 기간 | 배송 |
| 우편번호 | 예 | 불필요 | 민감 필드와 함께 암호화 | 동일 | 배송 |
| 배송 메모 | 필요한 값만 | 예 | 예 | 배송 완료 후 단기 | 이행 |
| 개인통관번호 | 1차 미저장 | 전부 비노출 | 해당 없음 | 없음 | 국내 떡 상품 불필요 |
| 선물 주문 정보 | 업무 필요 필드만 | 예 | 예 | 이행 기간 | 선물 배송 |
| 상품·금액·상태 | 예 | 아니요 | DB 보호 | 거래 정책 | 주문 처리 |
| redacted payload | 선택 저장 | 필수 | 민감정보 없음 | 30일 후보 | 장애 분석 |
| access token | DB 영구 저장 금지 | 전부 비노출 | process/cache 보호 | 최대 token TTL | API 인증 |

보존 기간은 개인정보처리방침·전자상거래 법적 의무와 실제 운영 목적을 법무가 확정해야 한다. 관리자 조회는 `channel_orders:read`, 원문 복호화는 별도 break-glass 권한과 감사가 필요하다. CSV export는 기본 비활성, 필요 시 범위 제한·승인·워터마크·감사·만료를 적용한다. 개발/staging과 fixture에는 가상 정보만 사용한다.

### 15. 관리자 화면

구현 요구사항:

- 채널 설정: 연결 상태, 마지막 인증·주문·재고 성공, sync enable, 연결 테스트. client secret/token 원문은 표시하지 않는다.
- 상품 매핑: 내부 상품, 원/채널/그룹 상품번호, 옵션 종류·ID, 관리 코드, 매핑·sync 상태, 재고 sync, 오류, 수동 재검증.
- 외부 주문: orderId/productOrderId, 내부 주문, import/mapping/order/claim 상태, 마지막 sync, 안전한 재처리.
- sync 이력: event, 대상 식별자, 성공/실패, attempt, safe error code, retry time, trace ID. 개인정보를 표시하지 않는다.
- dashboard: 지연, 미매핑, retry, 영구 실패, drift를 우선순위별로 표시한다.

권한 후보:

| 역할 | 권한 |
|---|---|
| viewer | `sales_channels:read`, `channel_orders:read`(마스킹) |
| operations | 위 + `channel_orders:retry`, `channel_inventory:sync` |
| finance | `sales_channels:read`, `channel_orders:read`; 외부 결제 snapshot 조회 |
| super_admin | 위 + `sales_channels:manage`; secret 교체는 별도 중요 작업 확인 |

복호화된 개인정보는 역할만으로 자동 허용하지 않고 업무 목적·감사 기반 별도 permission으로 분리한다.

### 16. 운영 모니터링

지표:

- 마지막 시도/성공 watermark, 현재 동기화 지연
- feed 수집·상세 조회·import 수, 중복 no-op 수
- 미매핑, manual review, retry pending, permanent failure
- 재고 push 성공/실패, drift, stale mapping
- 인증 오류, 429 rate/quota, 네트워크/5xx
- API별 제한 헤더와 provider latency

알림:

- 10분 이상 주문 sync 성공 없음(초기 후보)
- 인증 연속 실패 또는 권한/IP 403
- 미매핑 주문 1건 이상
- 재고 push 대량 실패/drift
- DB conflict·unknown enum 급증
- 로그 개인정보 탐지

모든 알림 threshold는 staging 관측 후 확정한다. trace ID는 저장하되 요청·응답 본문과 결합해 외부 티켓에 공개하지 않는다.

### 17. 환경변수 후보

공식 계약과 내부 naming을 반영한 후보이며 N1 migration/implementation 전에 확정한다.

```text
NAVER_COMMERCE_CLIENT_ID              # 비밀 취급 권장
NAVER_COMMERCE_CLIENT_SECRET          # secret manager 필수
NAVER_COMMERCE_ACCOUNT_ID             # type=SELLER일 때 판매자 ID/UID
NAVER_COMMERCE_TOKEN_TYPE=SELLER      # SELF 또는 SELLER
NAVER_COMMERCE_API_BASE_URL=https://api.commerce.naver.com/external
NAVER_COMMERCE_SYNC_ENABLED=false
```

`SELLER_ID`라는 임의 명칭 대신 공식 token의 `account_id` 의미를 반영한다. base URL override는 production allowlist로 공식 HTTPS host만 허용한다. access token은 만료가 있는 메모리/암호화 cache에 두고 DB 평문 영구 저장, 로그, 관리자 응답을 금지한다. 이번 단계에서는 `.env.example`을 수정하지 않는다.

### 18. 단계별 구현 계획

### 구현 단계

| 단계 | 범위 | 완료 기준 | 제외 |
|---|---|---|---|
| N0 | 내부 조사, 공식 계약, 모델·정책 | 본 문서 승인, 미확정 owner 지정 | 코드/API 호출 |
| N1 | 인증, token cache, API client, 제한 처리, 연결 테스트 | secret 비노출, 401/429/trace test, read-only account 확인 | 상품·주문 저장 |
| N2 | 상품 검색·단건 조회, mapping DB/UI | 옵션 없는 direct 매핑, UNIQUE·감사, 미매핑 검증 | 상품 write, 가격 sync |
| N3 | 변경 feed, 300 batch 상세, channel raw 정규화 | cursor overlap, idempotent read-only 저장, PII test | 내부 order·재고 변경 |
| N4 | 내부 order/item 변환, 외부 결제 snapshot | deterministic import, 상태 mapper, 중복 생성 0 | claim 자동화 |
| N5 | 완제품 reservation, safety stock, 재고 push/drift | 원상품 직렬화, 중복 차감 0, SUSPENSION 보호 | 가격 sync |
| N6 | 취소·반품·교환 수집과 관리자 검토 | 부분수량 모델·보상 검증, 승인형 처리 | 무승인 자동 환불 |
| N7 | scheduler, 발주/발송, monitoring, runbook | staging soak, alert·rollback drill, production 승인 | 범위 밖 API |

각 phase는 앞 phase를 production에 바로 활성화하지 않는다. feature flag 기본값은 false이며 N3 read-only 데이터를 staging에서 검증한 뒤 N4를 승인한다.

### 19. 의사결정 기록

### 1. 내부 주문 기준

결정: 네이버 `orderId` 1개를 내부 order 1개로, `productOrderId`를 item 외부 ID로 사용한다.
근거: 내부 order 1:N item 구조와 결제·배송 header가 일치한다.
대안: productOrderId마다 order 생성.
위험: 상품주문별 클레임·배송 분할.
후속 조치: item claim state와 필요 시 deterministic split link 도입.

### 2. 재고 원장

결정: 자체몰 단방향 push.
근거: 내부 생산·재고 transaction이 존재하고 양방향 충돌 규칙이 없다.
대안: 네이버 원장 또는 양방향.
위험: 현재는 원재료 원장뿐이다.
후속 조치: N5 전에 완제품 availability/reservation 모델 도입.

### 3. 재고 차감 시점

결정: PAYED 수집 시 완제품 예약, 생산 완료 때 원재료 실제 차감.
근거: 초과판매와 현재 생산 원장을 함께 보호한다.
대안: 즉시 원재료 차감 또는 관리자 승인 후 차감.
위험: 예약 모델 구현 전 이중 차감.
후속 조치: reservation ledger와 productOrderId UNIQUE 추가 전 자동 import 금지.

### 4. 초기 동기화 기간

결정: 30일 후보, 운영자 승인 후 확정.
근거: 검증 가능한 작은 범위로 시작한다.
대안: API가 허용하는 전체 기간.
위험: 공식 조회 기간·주문량 미확정.
후속 조치: N3에서 공식 제한과 dry-run 건수 확인.

### 5. 옵션 상품 1차 지원

결정: 미지원; 옵션 없는 direct 상품만.
근거: 내부 variant 모델이 없다.
대안: 문자열 옵션을 임시 매핑.
위험: 대상 상품 축소.
후속 조치: variant schema와 네이버 option ID 모델 후 확장.

### 6. 상담 상품 자동 연동

결정: 제외.
근거: 가격이 없고 맞춤·예약 생산이다.
대안: 문의형 외부 상품으로 수동 운영.
위험: 채널 상품 누락.
후속 조치: 별도 상담 workflow 사업 결정.

### 7. 가격 동기화 1차 포함

결정: 제외.
근거: 할인·쿠폰·옵션가·배송비 정산 차이.
대안: 정가 단방향 push.
위험: 수동 가격 drift.
후속 조치: read-only 가격 대사부터 설계.

### 8. 클레임 자동 처리 1차 포함

결정: 제외하고 수집·관리자 검토만.
근거: 내부 item/부분수량 claim이 없다.
대안: 전체 취소만 자동화.
위험: 수동 SLA.
후속 조치: N6에서 수량 클레임과 보상 transaction 검증.

### 9. raw payload

결정: 정규화 필드 + 최소 redacted payload, 30일 보존 후보.
근거: 장애 분석과 최소수집 균형.
대안: 암호화 raw 또는 완전 미저장.
위험: 일부 provider 문제 재현 한계.
후속 조치: 법무·보안 승인 후 보존 기간과 redaction test 확정.

### 10. 동기화 주기

결정: 변경 주문 2분 후보, 재고 5~15분 후보, 일일 mapping 감사.
근거: 공식 주문 poll 권장 1~3분과 제한 헤더 기반 적응.
대안: 더 짧은 poll 또는 batch.
위험: rate limit과 주문 지연.
후속 조치: staging 지표로 조정.

### 11. 안전 재고

결정: 사용, 상품별 기본 1 후보.
근거: 채널 간 동시 주문과 생산 lead time.
대안: 0 또는 카테고리 공통값.
위험: 과도한 품절 표시.
후속 조치: 판매량 기반 상품별 승인.

### 12. 네이버센터 수동 재고

결정: 원칙적 금지, drift 탐지 후 관리자 승인.
근거: 자체몰 원장과 덮어쓰기 경쟁 방지.
대안: 양방향 merge.
위험: 운영자가 긴급 변경할 수 있음.
후속 조치: emergency 변경 runbook과 재대사 제공.

### 20. 미확정 항목

공식 문서 추가 확인:

- 판매자 관리 코드의 정확한 허용 문자·byte 길이와 immutable 사용 가능성
- 초기/조건형 주문 조회의 최대 과거 기간과 page size
- API별 실제 rate limit 값은 고정 계약이 아니므로 staging 응답 헤더로 확인
- 모든 429 응답의 `Retry-After` 제공 여부
- 변경 feed `lastChangedType` 최신 전체 enum과 수량 클레임 release 영향
- 옵션 재고 변경 body의 옵션 종류별 필수 ID와 옵션 없는 상품 처리
- 발주·발송 batch 최대 개수와 부분 성공 응답 계약

운영자 결정 필요:

- 초기 import 기준일과 30일 후보 승인
- 완제품 재고 단위 및 안전 재고
- 네이버 주문을 pickup으로 허용할지 배송만 허용할지
- 개인정보·redacted payload 보존 기간과 암호화 키 운영
- 최소 2분 poll의 운영 SLA와 알림 threshold
- consultation 상품의 별도 수동 채널 운영 여부

구현 단계에서 확정:

- SQLite에서 token cache를 메모리로만 둘 때 다중 process 대응
- channel order와 내부 order split 조건
- 외부 결제 snapshot의 실제 table 경계
- item claim state machine과 reservation ledger schema
- 신규 permission의 기존 역할별 최종 배정
- scheduler leader election 및 배포 중 중복 worker 방지
