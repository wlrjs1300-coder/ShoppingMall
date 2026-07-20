# 소셜 로그인 연결 가이드

현재 서버는 Google·카카오·네이버의 Authorization Code OAuth 흐름을 지원한다. 키는 GitHub에 올리지 않고 `server/.env`에만 저장한다.

## 공통 콜백 URL

로컬 서버가 `http://localhost:3001`에서 실행된다면:

- Google: `http://localhost:3001/api/auth/social/google/callback`
- 카카오: `http://localhost:3001/api/auth/social/kakao/callback`
- 네이버: `http://localhost:3001/api/auth/social/naver/callback`

배포 후에는 `https://실제도메인`으로 정확히 바꾼다. 프로토콜, 도메인, 포트, 경로와 끝 슬래시까지 개발자 콘솔 등록값과 서버가 보내는 값이 일치해야 한다.

## 환경 변수

`server/.env.example`을 참고해 `server/.env`에 다음 값을 넣는다.

```dotenv
PUBLIC_BASE_URL=http://localhost:3001
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
KAKAO_CLIENT_ID=
KAKAO_CLIENT_SECRET=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
```

서버를 재시작하면 `/api/auth/social/providers`가 설정 완료된 제공자를 반환하고 로그인 버튼이 자동으로 활성화된다.

## Google

1. Google Cloud Console에서 OAuth 동의 화면을 구성한다.
2. OAuth 클라이언트를 `웹 애플리케이션` 유형으로 생성한다.
3. 승인된 리디렉션 URI에 Google 콜백 URL을 등록한다.
4. Client ID와 Client Secret을 환경 변수에 넣는다.
5. 공개 전에는 홈페이지, 개인정보처리방침, 이용약관과 소유 도메인을 확인한다.

공식 문서: https://developers.google.com/identity/protocols/oauth2/web-server

## 카카오

1. Kakao Developers에서 애플리케이션을 만든다.
2. 카카오 로그인 기능을 활성화하고 Redirect URI를 등록한다.
3. 동의항목에서 닉네임과 카카오계정 이메일을 설정한다.
4. REST API 키를 `KAKAO_CLIENT_ID`에 넣는다.
5. 보안의 Client Secret 기능을 사용한다면 코드를 `KAKAO_CLIENT_SECRET`에 넣는다.

공식 문서: https://developers.kakao.com/docs/ko/kakaologin/rest-api

## 네이버

1. NAVER Developers에서 `네이버 로그인` 애플리케이션을 등록한다.
2. 제공 정보로 이메일을 선택하고 서비스 URL·Callback URL을 등록한다.
3. Client ID와 Client Secret을 환경 변수에 넣는다.
4. 개발 상태에서는 등록한 테스트 계정으로 먼저 확인하고, 공개 시 서비스 적용 절차를 진행한다.

공식 문서: https://developers.naver.com/docs/login/api/api.md

## 현재 계정 연결 정책

소셜 로그인에서 인증된 이메일을 받으면 같은 이메일의 기존 일반 회원 계정에 소셜 식별자를 연결한다. 동일 이메일 회원이 없으면 자동 가입하지 않고 일반 회원가입을 먼저 요청한다. 이는 이용약관·개인정보 동의와 필수 배송 정보를 건너뛰는 자동 계정 생성을 막기 위한 현재 정책이다.

## 확인 순서

1. 일반 회원가입을 같은 이메일로 완료한다.
2. `/api/auth/social/providers`에서 제공자 이름이 보이는지 확인한다.
3. 로그인 페이지에서 제공자 버튼을 누른다.
4. 동의 후 `/api/auth/social/{provider}/callback`을 거쳐 메인으로 이동하는지 확인한다.
5. 마이페이지의 소셜 계정 연결 상태를 확인한다.
6. 이메일 동의를 거절했을 때 안전한 오류가 표시되는지 확인한다.

운영 키, Client Secret, 액세스 토큰은 화면 캡처·로그·Git 커밋에 포함하지 않는다.
