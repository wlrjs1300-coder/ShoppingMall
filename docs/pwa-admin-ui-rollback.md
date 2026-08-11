# PWA 관리자 UI 원복 안내

PWA 관리자 화면 시안은 `css/pwa-admin-refresh.css`에 분리되어 있습니다. 기존 데스크톱 관리자 스타일은 수정하지 않았습니다.

이번 시안을 원복하려면 `admin.html`에서 아래 링크 한 줄을 제거합니다.

```html
<link rel="stylesheet" href="css/pwa-admin-refresh.css?v=2" />
```

다시 적용하려면 `styles.css` 링크 바로 다음에 같은 링크를 복원합니다.
