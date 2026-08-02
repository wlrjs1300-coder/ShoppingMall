# 운영 DB 백업 및 복구

이 문서는 SQLite 운영 DB의 외부 백업, 복원 전 검증, 수동 복구 절차를 설명합니다. 백업 파일에는 주문과 고객 정보가 포함될 수 있으므로 접근 권한을 최소화하고 저장소 밖의 암호화된 저장소를 사용하세요.

백업 도구는 Node.js `22.16.0` 이상이 필요합니다.

## 설정

운영 환경에서는 `DB_PATH`와 `BACKUP_DIR`에 서로 다른 디렉터리의 절대 경로를 지정해야 합니다. `BACKUP_DIR`은 Git 저장소 밖에 있어야 합니다.

```text
# Windows 예시
BACKUP_DIR=D:\ShoppingMallBackups

# Linux 예시
BACKUP_DIR=/var/backups/shoppingmall

BACKUP_RETENTION_DAYS=30
BACKUP_MAX_FILES=30
```

실제 비밀값이나 운영 경로를 저장소의 `.env` 또는 문서에 기록하지 마세요. 운영 계정은 백업 디렉터리에 쓰기 권한이 필요합니다.

## 생성과 검증

서버를 종료하지 않고 Node SQLite backup API로 일관된 snapshot을 생성합니다. 성공한 한 세트는 `.sqlite`, `.sqlite.sha256`, `.json` 파일로 구성됩니다.

```powershell
cd server
npm run backup:create
npm run backup:verify
npm run backup:verify -- --file shoppingmall-YYYYMMDDTHHMMSSZ.sqlite
```

```bash
cd server
npm run backup:create
npm run backup:verify
npm run backup:verify -- --file shoppingmall-YYYYMMDDTHHMMSSZ.sqlite
```

검증 명령은 체크섬 확인 후 임시 디렉터리에 복사하여 `integrity_check`, `foreign_key_check`, 필수 테이블과 주요 테이블 조회를 수행합니다. 원본 백업과 운영 DB는 변경하지 않습니다. 파일 인자는 `BACKUP_DIR` 안의 파일명만 허용합니다.

백업 성공 후에만 기간 및 최대 개수 정책이 적용됩니다. 알 수 없는 파일, 불완전한 세트와 생성 중인 `.tmp` 파일은 자동 삭제하지 않습니다.

## 운영 DB 수동 복구

`db:restore` 자동 명령과 HTTP 복구 API는 제공하지 않습니다. 복구는 승인된 운영 담당자가 서비스를 중지한 점검 시간에 수동으로 진행합니다. 임의 SQLite 파일이나 체크섬 및 `backup:verify`를 통과하지 않은 파일은 복원하지 마세요.

1. 서비스로 들어오는 트래픽을 차단하고 서버 프로세스를 중지합니다.
2. 교체 전 현재 DB와 `-wal`, `-shm` 파일을 별도의 보호 경로에 보존합니다.
3. 선택한 백업의 checksum을 확인하고 `npm run backup:verify -- --file <파일명>`을 반드시 통과시킵니다.
4. 별도 임시 디렉터리에서 백업 복사본을 SQLite로 열어 검증 결과를 다시 확인합니다.
5. 검증된 `.sqlite` 파일을 운영 `DB_PATH` 위치에 복사합니다. 기존 파일에 직접 덮어쓰기보다 같은 파일시스템에서 임시 이름으로 복사 후 이름을 교체하세요.
6. 서비스 계정의 파일 소유권과 읽기·쓰기 권한을 확인합니다.
7. 서버를 시작합니다.
8. health endpoint와 `npm run deploy:check` 결과를 확인합니다.
9. 관리자 화면에서 주문, 결제, 재고, 발주와 활동 로그의 표본을 확인합니다.
10. 문제가 있으면 서비스를 다시 중지하고 2단계에서 보존한 DB로 같은 절차를 수행해 rollback합니다.

Windows PowerShell의 운영 절차에서는 `Stop-Service`, `Copy-Item -LiteralPath`, `Move-Item -LiteralPath`, `Start-Service`를 실제 서비스 이름과 승인된 경로로 사용합니다. Linux에서는 서비스 관리자에 맞는 `systemctl stop/start`, `cp --preserve`, `mv`를 사용합니다. 경로와 서비스 이름은 운영 환경마다 다르므로 이 문서에 실제 값을 고정하지 않습니다.

## 운영 점검

- 외부 저장소의 암호화, 접근 통제와 별도 장애 도메인을 확인합니다.
- 백업 작업 성공 여부를 모니터링하고 실패 알림을 구성합니다.
- 정기적으로 임시 환경에서 복원 훈련을 수행하고 결과를 기록합니다.
- 보존 기간은 개인정보 및 운영 정책에 따라 확정합니다.
- 백업 파일을 Git, 일반 로그, 공개 artifact에 포함하지 않습니다.
