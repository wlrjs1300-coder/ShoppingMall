# 관리자 상품 관리 설계

> **상태: 향후 개선을 위한 미구현 설계 문서입니다.** 현재 상품은 `products` 테이블과 공개 `GET /api/products`에서 통합 조회되지만, 아래의 관리자 상품 CRUD 화면과 `/api/admin/products` API는 아직 구현되지 않았습니다.

## 목적

향후 상품 ID, 이름, 가격, 이미지, 판매 방식과 판매 상태를 관리자 화면에서 변경할 수 있게 하고, 메뉴·상품 상세·장바구니·주문 API가 같은 데이터를 사용하도록 확장하는 것이 목적입니다.

## 관리 화면

- 관리자 메뉴에 `상품 관리` 탭 추가
- 목록 컬럼: 표시 순서, 이미지, 상품명, 분류, 판매 방식, 가격, 상태, 수정일
- 검색: 상품명·ID
- 필터: 분류, 판매 방식, 판매중·판매중지
- 작업: 신규 등록, 수정, 판매중지, 판매 재개, 표시 순서 변경
- 운영 주문과 연결된 상품은 영구 삭제하지 않고 `inactive`로 변경

## 입력 규칙

- `id`: 영문 소문자·숫자·하이픈, 생성 후 변경 불가
- `name`: 필수, 1~100자
- `category`: 허용된 카테고리 중 선택
- `purchaseType`: `direct` 또는 `consultation`
- `price`: 직접 구매 상품은 1원 이상의 정수, 상담 상품은 `null`
- `imageUrl`: 프로젝트 내부 이미지 경로 또는 향후 업로드 결과 URL
- `description`: 최대 500자
- `displayOrder`: 0 이상의 정수
- `status`: `active` 또는 `inactive`

## 관리자 API

모든 경로는 관리자 JWT 인증을 필수로 합니다.

```text
GET    /api/admin/products
POST   /api/admin/products
PUT    /api/admin/products/:id
PATCH  /api/admin/products/:id/status
PATCH  /api/admin/products/reorder
```

- 공개 `GET /api/products`는 `active` 상품만 반환
- 공개 단일 조회와 주문 생성도 `active` 여부를 다시 검사
- 가격·판매 상태 변경은 서버에서 검증하고 `updated_at` 갱신
- 변경 작업은 관리자 활동 로그에 기록

## 장바구니 정책

- 장바구니에는 상품 ID와 수량을 중심으로 저장
- 장바구니 페이지 진입 시 공개 상품 API로 이름·가격·이미지·판매 상태 갱신
- 판매중지·삭제·상담 전용으로 변경된 상품은 장바구니에서 제외하고 안내 표시
- 주문 생성 시 서버가 상품 DB를 다시 조회하므로 오래된 장바구니 가격은 주문 금액에 사용하지 않음

## 구현 순서

1. 관리자 상품 CRUD API와 권한 테스트
2. 관리자 상품 목록·등록·수정 폼
3. 이미지 업로드 저장소 결정
4. 정렬 UI와 활동 로그
5. 관리자 변경 후 메뉴·장바구니·주문 통합 테스트
