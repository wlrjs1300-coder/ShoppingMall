# QA 점검 결과

점검일: 2026-06-21

## 점검 항목

- `script.js` 문법 검사
- 주요 HTML 링크 확인
- 삭제된 페이지 링크 잔여 여부 확인
- 이미지, CSS, JS 참조 경로 확인
- 루트 폴더와 `docs` 폴더 파일 구성 확인
- 실행 파일 목록 확인

## 점검 결과

| 항목 | 결과 |
| --- | --- |
| JavaScript 문법 | 통과 |
| 메인/메뉴/FAQ/관리자 페이지 연결 | 정상 |
| 삭제된 페이지 링크 잔여 여부 | 없음 |
| 관리자 실행 파일 | 정상 구성 |
| 발표 문서 폴더 | 정상 구성 |
| 이미지 참조 | 정상 |
| CSS/JS 참조 | 정상 |

## 확인된 실행 파일

- `open-homepage.cmd`
- `open-menu.cmd`
- `open-admin.cmd`
- `open-admin-demo.cmd`
- `open-presentation-docs.cmd`

## 확인된 문서

- `docs/README.md`
- `docs/PROJECT_SUMMARY.md`
- `docs/PRESENTATION_GUIDE.md`
- `docs/DEMO_SCENARIO.md`
- `docs/QA_CHECKLIST.md`

## 메모

- `지도 보기` 링크는 HTML에서는 `#`로 시작하지만, 페이지 로드 후 `script.js`에서 네이버 지도 검색 주소로 자동 변경됩니다.
- 관리자 확인 코드는 현재 임시 코드 `4525`입니다.
- 실제 운영 전에는 서버 로그인, 데이터베이스 저장, 스마트스토어 연동이 필요합니다.
