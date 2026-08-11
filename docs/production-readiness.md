# Production readiness

## 1. 목적

이 문서는 staging 검증, production 승인, 장애 시 rollback의 단일 체크리스트다. 비밀값은 문서나 Git에 기록하지 않고 배포 플랫폼의 비밀 저장소에 입력한다. `deploy:check`는 읽기 전용이며 DB, 백업 파일, 관리자 계정을 만들거나 변경하지 않는다.

## 2. 환경 구분

| 환경 | 목적 | 원칙 |
|---|---|---|
| development | 로컬 개발 | 개발용 DB와 테스트 결제만 사용 |
| test | 자동 테스트 | 격리된 `:memory:` 또는 임시 DB 사용 |
| staging | production 유사 사전 검증 | `NODE_ENV=production`을 유지하고 별도 도메인·DB·키를 사용 |
| production | 실제 서비스 | 실제 도메인, 영구 DB, 외부 백업, 운영 키만 사용 |

배포 환경은 `NODE_ENV=production`을 공통으로 유지하고 `APP_ENV=staging|production`으로 데이터·provider 정책을 구분한다. local/test는 기존 동작과 호환되는 `local`/`test` 기본값을 사용한다.

## 3. 필수 환경변수

| 환경변수 | production | 비밀값 | 형식·검증 | 설정 위치 |
|---|---:|---:|---|---|
| `NODE_ENV` | 필수 | 아니요 | `production` | 배포 런타임 |
| `APP_ENV` | 필수 | 아니요 | 배포 시 `staging` 또는 `production` | 배포 런타임 |
| `PORT` | 플랫폼별 | 아니요 | 양의 포트 | 배포 런타임 |
| `PUBLIC_BASE_URL` | 필수 | 아니요 | `https://shop.example.com`, origin 기준 | 배포 환경 |
| `ALLOWED_ORIGIN` | 필수 | 아니요 | HTTPS origin 쉼표 목록, path·`*` 금지 | 배포 환경 |
| `DB_PATH` | 필수 | 민감 경로 | 절대경로, 저장소·임시·`:memory:` 금지 | 영구 볼륨 |
| `BACKUP_DIR` | 필수 | 민감 경로 | 절대경로, 저장소와 DB 디렉터리 밖 | 외부 영구 볼륨 |
| `BACKUP_RETENTION_DAYS` | 선택(기본 30) | 아니요 | 양의 정수 | 배포 환경 |
| `BACKUP_MAX_FILES` | 선택(기본 30) | 아니요 | 양의 정수 | 배포 환경 |
| `JWT_SECRET` | 필수 | 예 | 32바이트 이상, placeholder 금지 | 비밀 저장소 |
| `AUTH_CODE_PEPPER` | 필수 | 예 | 32바이트 이상, JWT secret과 별도 | 비밀 저장소 |
| `ADMIN_JWT_ISSUER` | 필수 | 아니요 | 비어 있지 않은 고유 식별자 | 배포 환경 |
| `ADMIN_JWT_AUDIENCE` | 필수 | 아니요 | issuer와 구분 권장 | 배포 환경 |
| `ADMIN_TOKEN_TTL` | 필수 | 아니요 | `1h` 같은 양의 `m/h/d` 값 | 배포 환경 |
| `ADMIN_LOGIN_RATE_MAX` | 필수 | 아니요 | 양의 정수 | 배포 환경 |
| `ADMIN_LOGIN_RATE_WINDOW_MS` | 필수 | 아니요 | 양의 정수(ms) | 배포 환경 |
| `ORDER_PII_PROTECTION_ENABLED` | 필수 | 아니요 | staging·production 모두 `true` | 배포 환경 |
| `ORDER_PII_KEYS_JSON` | 필수 | 예 | Base64 32바이트 키를 포함한 version keyring | 비밀 저장소 |
| `ORDER_PII_ACTIVE_KEY_VERSION` | 필수 | 예 | keyring에 존재하는 활성 version | 비밀 저장소 |
| `PAYMENT_MODE` | 필수 | 아니요 | `disabled` 또는 `toss` | 배포 환경 |
| `TOSS_CLIENT_KEY` | toss일 때 | 아니요 | 운영 client key, `test_` 금지 | 배포 환경 |
| `TOSS_SECRET_KEY` | toss일 때 | 예 | 운영 secret key, `test_` 금지 | 비밀 저장소 |
| `TOSS_MOCK_MODE` | toss일 때 | 아니요 | 반드시 `false` | 배포 환경 |
| `STORE_NAME/PHONE/HOURS/ADDRESS` | 필수 | 아니요 | 실제 공개 정보, placeholder 금지 | 배포 환경 |

현재 구현에는 `CORS_ALLOWED_ORIGINS`, `TOSS_WEBHOOK_SECRET`, `TERMS_URL`, `PRIVACY_URL` 계약이 없다. CORS는 `ALLOWED_ORIGIN`, 법률 문서는 정적 `terms.html`과 `privacy.html`을 사용한다. webhook은 provider 재조회로 검증하며 공개 URL은 `{PUBLIC_BASE_URL}/api/payments/webhook`이다.

## 4. 비밀값 관리

- [ ] 실제 JWT, Toss secret, 인증 pepper, legacy 관리자 코드를 Git·문서·로그에 남기지 않았다.
- [ ] production에서 `ALLOW_LEGACY_ADMIN_LOGIN=true`와 demo/test 변수가 없다.
- [ ] staging과 production의 DB, JWT, Toss 키가 분리됐다.
- [ ] staging과 production의 주문 PII keyring이 서로 다르고 암호화가 강제된다.
- [ ] 배포 담당자만 비밀 저장소 읽기·변경 권한을 갖는다.

## 5. DB 준비

- [ ] `DB_PATH`가 영구 볼륨의 절대경로이며 저장소 밖이다.
- [ ] 실행 계정이 부모 디렉터리를 읽고 쓸 수 있다.
- [ ] 단일 SQLite writer 인스턴스 정책을 확인했다.
- [ ] WAL·SHM 파일을 포함한 종료/복원 절차를 숙지했다.
- [ ] `GET /api/health`의 `database: ready`와 schema version을 확인했다.

## 6. 백업 준비

- [ ] `BACKUP_DIR`이 DB 디렉터리와 분리되어 있다.
- [ ] Render의 동일 영구 디스크 안에 있는 `BACKUP_DIR` 사본은 재해복구 백업으로 계산하지 않는다.
- [ ] 검증된 백업을 다른 저장소·계정으로 반출하는 절차와 담당자가 있다.
- [ ] `npm run backup:create` 실행과 보존 정책을 등록했다. Render Cron Job은 웹 서비스 영구 디스크에 접근할 수 없으므로 해당 방식에 의존하지 않는다.
- [ ] `npm run backup:verify` 정기 실행과 알림 담당자를 정했다.
- [ ] 복원 훈련 일정과 최근 성공 기록이 있다.

## 7. 결제 준비

- [ ] staging은 `PAYMENT_MODE=disabled`, `TOSS_MOCK_MODE=false`이고 Toss credential을 설정하지 않는다.
- [ ] production의 `PAYMENT_MODE`, 운영 키, mock 비활성화를 이중 확인했다.
- [ ] success/fail URL과 `/api/payments/webhook`이 같은 HTTPS 운영 도메인에 노출된다.
- [ ] 브라우저·로그·응답에 Toss secret이 노출되지 않음을 확인했다.
- [ ] 실제 최소금액 승인·즉시 취소는 별도 운영 승인 창에서만 수행한다.

## 8. 관리자 계정 준비

- [ ] 최소 2명의 활성 `super_admin`과 정기 권한 회수 담당자가 있다.
- [ ] viewer 읽기 전용, operations 주문·재고, finance 결제 조회 권한을 확인했다.
- [ ] legacy `ADMIN_CODE` 로그인이 production에서 비활성이다.
- [ ] 관리자 로그인 rate limit과 JWT issuer/audience/TTL을 확인했다.

## 9. 법률·매장정보 준비

- [ ] `terms.html`, `privacy.html`을 법무·개인정보 담당자가 최종 승인했다.
- [ ] 사업자 정보, 연락처, 주소, 영업시간이 실제 정보다.
- [ ] 환불·취소 정책과 개인정보 보유기간이 현재 운영과 일치한다.

## 10. staging 배포 전 검증

```powershell
cd server
npm test
npm run deploy:check
npm run backup:create
npm run backup:verify
```

- [ ] staging 전용 도메인·TLS·DB·백업·관리자를 사용하며 외부 provider credential을 설정하지 않는다.
- [ ] production 고객 데이터와 운영 결제 키를 사용하지 않는다.

## 11. staging smoke test

- [ ] `GET /api/health`
- [ ] 테스트 회원 가입/로그인/로그아웃
- [ ] 관리자 로그인과 `/api/auth/me`
- [ ] viewer 쓰기 차단, operations 주문·재고 접근, finance 결제 조회
- [ ] synthetic 주문 생성과 provider-disabled 결제 동작, 결제 상태와 재고 반영
- [ ] 백업 생성·검증과 감사 로그 확인

## 12. production 배포 전 검증

- [ ] `deploy:check` error가 0이다.
- [ ] 모든 `confirm-needed`를 담당자가 서명했다.
- [ ] DNS·TLS, DB 경로·권한, 외부 백업 스케줄을 확인했다.
- [ ] 최근 검증된 백업과 직전 application artifact가 있다.
- [ ] cookie가 production에서 `HttpOnly`, `Secure`, `SameSite=Lax`이고 CORS에 wildcard가 없다.

## 13. production 배포 후 smoke test

- [ ] health 응답, 정적 파일, 메뉴 조회, 로그인 페이지와 관리자 로그인 페이지
- [ ] DB read, 백업 디렉터리 접근, 설정된 Toss mode
- [ ] 보안 헤더, CORS 허용/차단 origin, 고객 cookie 속성
- [ ] 실제 고객 주문이나 결제를 만들지 않는 읽기 중심 점검

## 14. rollback 기준

서버 시작·migration·health·관리자 로그인·주문 조회 실패, 결제 상태 불일치, DB integrity/foreign-key/백업 검증 실패, 지속적인 5xx, 전면 CORS/cookie 장애, 권한 우회가 발견되면 즉시 rollback한다.

## 15. 장애 대응

1. 신규 트래픽과 배포를 중지하고 현재 로그·request ID를 보존한다.
2. DB 변경 여부와 백업 검증 결과를 확인한다.
3. 직전 검증 application artifact로 되돌린다.
4. DB 복원이 필요한 경우에만 서비스를 중지하고 [백업·복구 절차](backup-and-recovery.md)의 수동 승인 절차를 따른다.
5. health, 관리자, 주문, 결제, 재고를 확인하고 사고 기록을 남긴다.

자동 DB 복원 명령은 제공하지 않는다.

## 16. 운영 승인 체크리스트

- [ ] 기술 담당: deploy check와 smoke test
- [ ] 보안 담당: 비밀값, 관리자, CORS/cookie
- [ ] 데이터 담당: DB, 백업, 복원 훈련
- [ ] 결제 담당: Toss 운영 전환
- [ ] 사업 담당: 법률 문서와 매장 정보
- [ ] 배포 승인자: rollback artifact와 담당자 연락망
