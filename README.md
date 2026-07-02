# 따뜻한 떡집

경기 화성 동탄 소재 떡집을 위한 온라인 쇼핑몰 + 관리자 ERP 시스템입니다.  
고객용 메뉴·주문 문의 페이지와 주문·생산·재고·매출을 한 화면에서 처리하는 관리자 대시보드로 구성됩니다.

---

## 기술 스택

| 구분 | 사용 기술 |
|------|-----------|
| **Frontend** | HTML5, CSS3, Vanilla JS (ES2022) |
| **Backend** | Node.js 22+, Express 4 |
| **DB** | SQLite (`node:sqlite` — Node.js 내장, 별도 설치 불필요) |
| **인증** | JWT (`jsonwebtoken`) |
| **결제** | 토스페이먼츠 SDK v2 |
| **알림** | Solapi SMS·카카오 알림톡 (옵션) |
| **PWA** | Service Worker + Web App Manifest |

---

## 프로젝트 구조

```
쇼핑몰/
├── index.html          # 브랜드 홈페이지
├── menu.html           # 메뉴 목록 + 주문 문의 접수
├── faq.html            # 자주 묻는 질문
├── admin.html          # 관리자 ERP 대시보드
├── pay.html            # 토스페이먼츠 결제 페이지
├── script.js           # 전체 클라이언트 로직
├── styles.css          # 전체 스타일시트
├── sw.js               # PWA Service Worker
├── manifest.json       # PWA 매니페스트
├── assets/
│   ├── logo.svg
│   ├── tteok-hero.png
│   └── products/       # 상품 이미지
├── docs/               # 기술 문서·발표 자료
└── server/
    ├── index.js        # 서버 진입점 (Express)
    ├── db.js           # SQLite 스키마 초기화
    ├── .env            # 환경변수 (gitignore)
    ├── middleware/
    │   └── auth.js     # JWT Bearer 인증 미들웨어
    ├── routes/
    │   ├── auth.js           # POST /api/auth/login
    │   ├── orders.js         # /api/orders
    │   ├── customers.js      # /api/customers
    │   ├── inventory.js      # /api/inventory
    │   ├── recipes.js        # /api/recipes
    │   ├── purchase-orders.js# /api/purchase-orders
    │   ├── suppliers.js      # /api/suppliers
    │   ├── activity-logs.js  # /api/activity-logs
    │   ├── notify.js         # /api/notify
    │   └── payments.js       # /api/payments
    └── services/
        └── notify.js         # SMS·카카오 알림 발송 서비스
```

---

## 설치 및 실행

### 사전 요구사항

- **Node.js 22 이상** (내장 `node:sqlite` 사용)

### 1. 의존성 설치

```bash
cd server
npm install
```

### 2. 환경변수 설정

`server/.env` 파일을 생성하고 아래 값을 입력합니다.

```env
# 관리자 접근 코드
ADMIN_CODE=4525

# JWT 서명 시크릿 (운영 환경에서는 반드시 변경)
JWT_SECRET=your-secret-here

# 서버 포트 (기본값 3000)
PORT=3000

# 매장 정보 (알림 발송 시 사용)
STORE_NAME=따뜻한 떡집
STORE_PHONE=031-374-4525

# 알림 모드: none | sms | kakao
NOTIFICATION_MODE=none

# Solapi (SMS/카카오) — NOTIFICATION_MODE가 none이면 불필요
SOLAPI_API_KEY=
SOLAPI_API_SECRET=
SOLAPI_SENDER=
KAKAO_SENDER_KEY=

# 카카오 알림톡 템플릿 ID
KAKAO_TEMPLATE_ORDER=
KAKAO_TEMPLATE_READY=
KAKAO_TEMPLATE_REMINDER=

# 토스페이먼츠 키 (샌드박스 테스트키로 시작 가능)
TOSS_CLIENT_KEY=test_ck_...
TOSS_SECRET_KEY=test_sk_...
```

### 3. 서버 실행

```bash
# 운영
npm start

# 개발 (파일 변경 감지, Node.js 22+ 내장 --watch)
npm run dev
```

서버가 `http://localhost:3000`에서 실행됩니다.

### 4. 사이트 접속

서버 실행 후 브라우저에서 아래 주소로 접속합니다.

| 페이지 | 주소 |
|--------|------|
| 홈 | `http://localhost:3000` 또는 `index.html` 직접 열기 |
| 메뉴·주문 | `menu.html` |
| FAQ | `faq.html` |
| 관리자 | `admin.html` |

> **참고:** 프론트엔드 파일(`index.html` 등)은 서버 없이 브라우저에서 직접 열어도 동작합니다. 서버가 없을 경우 localStorage를 폴백으로 사용합니다.

---

## 관리자 접근

1. `admin.html` 접속
2. 확인 코드 **`4525`** 입력 (`.env`의 `ADMIN_CODE` 값)
3. 우측 상단 **관리 잠금** 버튼으로 잠금 가능

> 테스트용 데모 데이터 버튼은 `admin.html?dev=1`로 접속 시에만 표시됩니다.

---

## 주요 기능

### 고객용 페이지

- **홈** (`index.html`) — 브랜드 소개, 주요 메뉴 안내, 매장 정보
- **메뉴** (`menu.html`) — 29개 메뉴 카탈로그, 카테고리·키워드 필터, 페이지네이션, 상품 상세, 주문 문의 접수
- **FAQ** (`faq.html`) — 주문·예약·배송 관련 자주 묻는 질문 아코디언

### 관리자 ERP (`admin.html`)

| 탭 | 기능 |
|----|------|
| **주문관리** | 주문 목록 조회·등록·수정·삭제, 상태 필터, 인쇄, 결제 링크 생성, CSV/JSON 내보내기·가져오기 |
| **고객관리** | 고객 등록·수정·삭제, 주문 이력 집계(횟수·수량·매출), 메모 |
| **생산관리** | 픽업일 기준 생산량 집계, 준비완료 처리 시 재고 자동 차감 |
| **재고관리** | 원재료 재고 CRUD, 안전재고·부족/주의 상태, 발주 요청·진행·입고 관리, 공급처 관리, 배합표 관리, 사용이력 로그 |
| **픽업/배송** | 날짜 필터, 수령방식·물류상태 관리 |
| **매출관리** | 상품별·일자별 매출 집계, 최근 12개월 월별 손익 차트, 순현금흐름, 회계 CSV |

### 결제 (`pay.html`)

- 관리자가 주문에서 결제 링크 생성 → 고객에게 링크 전달
- 토스페이먼츠 SDK v2로 결제 위젯 렌더링
- 결제 완료 시 주문 상태 자동으로 `결제완료` 갱신

### 알림

- **브라우저 Push 알림** — D-1 픽업 안내, 재고 부족 경고 (별도 설정 없이 동작)
- **SMS·카카오 알림톡** — `NOTIFICATION_MODE=sms|kakao` + Solapi 설정 시 활성화
  - 주문 접수 안내, 준비완료 안내, D-1 픽업 리마인더
  - 매일 오전 9시 자동 발송 스케줄러 내장

---

## API 엔드포인트

| 메서드 | 경로 | 인증 | 설명 |
|--------|------|------|------|
| `POST` | `/api/auth/login` | 불필요 | 관리자 로그인 → JWT 발급 |
| `GET/POST` | `/api/orders` | GET 필요 | 주문 목록 조회 / 주문 접수 |
| `PUT/DELETE` | `/api/orders/:id` | 필요 | 주문 수정·삭제 |
| `GET/POST/PUT/DELETE` | `/api/customers` | 필요 | 고객 CRUD |
| `GET/PUT/DELETE` | `/api/customers/notes/:key` | 필요 | 고객 메모 관리 |
| `GET/POST/PUT/DELETE` | `/api/inventory` | 필요 | 재고 CRUD |
| `GET/POST/DELETE` | `/api/inventory/logs` | 필요 | 재고 사용이력 |
| `GET/PUT/DELETE` | `/api/recipes` | 필요 | 배합표 관리 |
| `GET/POST/PUT/DELETE` | `/api/purchase-orders` | 필요 | 발주 CRUD |
| `GET/POST/PUT/DELETE` | `/api/suppliers` | 필요 | 공급처 CRUD |
| `GET/POST/DELETE` | `/api/activity-logs` | 필요 | 활동 로그 |
| `POST` | `/api/notify/test` | 필요 | 테스트 알림 발송 |
| `POST` | `/api/notify/reminders` | 필요 | 리마인더 즉시 실행 |
| `GET/POST` | `/api/payments` | 일부 | 결제 생성·조회·승인 |
| `GET` | `/api/health` | 불필요 | 헬스체크 |

---

## 데이터베이스

Node.js 22+ 내장 `node:sqlite` (`DatabaseSync`)를 사용해 별도 패키지 설치 없이 SQLite를 사용합니다.  
DB 파일은 `server/tteokjip.db`에 자동 생성됩니다.

| 테이블 | 설명 |
|--------|------|
| `orders` | 주문 |
| `customers` | 고객 |
| `customer_notes` | 고객 메모 |
| `inventory` | 재고 품목 |
| `inventory_logs` | 재고 사용이력 |
| `recipes` | 상품별 원재료 배합표 |
| `purchase_orders` | 발주 |
| `suppliers` | 공급처 |
| `activity_logs` | 운영 활동 로그 |
| `payments` | 결제 내역 |

---

## 오프라인 동작

서버가 실행되지 않은 경우 `script.js`는 자동으로 localStorage를 폴백 저장소로 사용합니다.  
서버가 다시 기동되면 localStorage의 데이터와 API가 동기화됩니다.  
PWA Service Worker(`sw.js`)로 정적 파일을 캐시해 오프라인에서도 페이지 열람이 가능합니다.

---

## 매장 정보

- **상호**: 따뜻한 떡집
- **주소**: 경기 화성시 동탄구 동탄대로 198 드림타워 1층 116호
- **전화**: 031-374-4525
- **영업시간**: ~19:00

---

## 문서

`docs/` 디렉토리에 추가 문서가 있습니다.

| 파일 | 내용 |
|------|------|
| `TECHNICAL_OVERVIEW.md` | 아키텍처·파일 구조·데이터 흐름 |
| `PROJECT_SUMMARY.md` | 구현 기능 요약 및 시연 가이드 |
| `PRESENTATION_GUIDE.md` | 발표 순서·예상 질문 답변 |
| `DEMO_SCENARIO.md` | 데모 시나리오 |
| `QA_CHECKLIST.md` | 배포 전 QA 체크리스트 |
