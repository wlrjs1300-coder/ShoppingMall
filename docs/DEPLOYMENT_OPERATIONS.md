# 배포 및 데이터 운영 가이드

## 권장 배포 구조

- 앱 루트는 저장소 루트, 빌드 명령은 `cd server && npm ci`, 시작 명령은 `cd server && npm start`입니다.
- SQLite를 유지하는 동안 인스턴스는 **1개만** 운영합니다. 수평 확장이나 다중 인스턴스가 필요해지면 PostgreSQL로 전환합니다.
- Railway는 서비스에 볼륨을 연결하고 마운트 경로를 `/data`로 지정합니다. `DB_PATH=/data/tteokjip.db`, `BACKUP_DIR=/data/backups`를 설정합니다.
- Render는 저장소의 `render.yaml`이 `/data` 영구 디스크와 `/api/health` 헬스체크를 선언합니다.

## 필수 운영 환경변수

`NODE_ENV=production`, `ADMIN_CODE`, 32바이트 이상의 `JWT_SECRET`, 별도의 32바이트 이상 `AUTH_CODE_PEPPER`, `DB_PATH`, HTTPS 형식의 `ALLOWED_ORIGIN`과 `PUBLIC_BASE_URL`이 필요합니다. 누락되거나 예시 값이면 서버가 시작되지 않습니다.

```powershell
# 안전한 48바이트 base64 시크릿 예시(로컬에서 실행)
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

실제 기능을 켤 때만 Solapi, Resend, 소셜 로그인, Toss 값을 추가합니다. 비밀 값은 Git에 커밋하지 않습니다.

배포 전에는 실제 배포 환경변수를 불러온 터미널에서 사전 점검을 실행합니다.

```bash
cd server
npm run deploy:check
```

오류가 1개라도 있으면 종료 코드 1을 반환합니다. 확인 필요 항목은 포트폴리오 배포에서는 허용할 수 있지만, 실제 주문을 받기 전에는 매장 연락처·주소, Toss, Solapi, Resend와 법무 문서를 모두 확정해야 합니다.

화면에 표시되는 매장 정보는 `STORE_NAME`, `STORE_PHONE`, `STORE_HOURS`, `STORE_ADDRESS`, `STORE_PARKING`, `STORE_URL`에서 읽습니다. 서버 재시작 후 `/api/site-config`에서 비밀값을 제외한 공개 정보만 확인할 수 있습니다.

## 도메인·HTTPS·쿠키 점검

1. 플랫폼에 사용자 도메인을 연결하고 HTTPS 인증서 발급이 끝났는지 확인합니다.
2. `ALLOWED_ORIGIN`과 `PUBLIC_BASE_URL`을 `https://실제도메인`으로 동일하게 설정합니다.
3. 브라우저 개발자 도구에서 `tteok_customer_token`이 `HttpOnly`, `Secure`, `SameSite=Lax`인지 확인합니다.
4. `/api/health`가 `200`, `database: ready`, 최신 `schemaVersion`을 반환하는지 확인합니다.
5. `/api/site-config`에 실제 매장 연락처와 주소가 표시되는지 확인합니다.

## 마이그레이션

서버 시작 시 `schema_migrations`를 기준으로 아직 적용되지 않은 버전만 트랜잭션으로 실행합니다. 새 스키마 변경은 `server/migrations.js`에 기존 버전을 수정하지 않고 다음 번호로 추가합니다. Railway 볼륨은 pre-deploy 단계에 마운트되지 않을 수 있으므로 마이그레이션은 현재처럼 앱 시작 과정에서 실행합니다.

## 백업과 복원

```bash
cd server
npm run db:backup
npm run db:restore -- /data/backups/tteokjip-날짜.db --confirm
```

- `db:backup`은 SQLite `VACUUM INTO`를 사용해 일관된 백업을 만들고 기본 14개를 보존합니다.
- 플랫폼 스케줄러 또는 외부 cron으로 하루 1회 `npm run db:backup`을 실행합니다.
- 플랫폼 자체 볼륨 백업도 함께 켜서 앱 백업과 이중화합니다.
- 복원 전 서버를 중지하고 현재 DB와 `-wal`, `-shm` 파일을 함께 다룹니다. 복원 도구는 기존 DB 사본을 남기고 백업 무결성을 검사합니다.
- 월 1회 별도 환경에서 복원 후 `/api/health`, 회원 수, 최근 주문을 대조합니다.

## 모니터링과 장애 대응

- 배포 헬스체크: `/api/health`
- 외부 가동 감시: 5분 간격으로 `/api/health`를 호출하고 2회 연속 실패 시 알림
- 서버 오류 로그는 JSON 형식이며 `requestId`, 경로, 상태 코드, 처리 시간을 포함합니다. 응답의 `requestId`로 플랫폼 로그를 검색합니다.
- 5xx 증가 시 최근 배포를 확인하고 DB 볼륨 용량·쓰기 권한·환경변수 누락을 우선 점검합니다.
- 외부 모니터링 서비스 연결은 배포 URL 확정 후 진행합니다.

## PostgreSQL 전환 시점

다중 인스턴스, 동시 쓰기 증가, 무중단 배포, 관리형 자동 백업이 필요하면 전환합니다. 전환 전 스키마 변환, SQLite 데이터 내보내기, 정합성 비교, 롤백 계획을 별도 작업으로 수행합니다.

## 공개 전 법무 문서

`privacy.html`과 `terms.html`은 포트폴리오용 초안입니다. 실제 영업 공개 전 사업자 정보, 개인정보 책임자, 보유 기간, 위탁 업체, 교환·환불 조건을 전문가 또는 관련 가이드에 맞춰 확정해야 합니다.
