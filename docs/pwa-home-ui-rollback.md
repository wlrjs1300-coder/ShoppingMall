# PWA 메인 UI 시안 원복 안내

이번 시안은 `css/pwa-home-refresh.css`와 `js/pwa-home-refresh.js`에만 들어 있습니다. 기존 공통 스타일과 배너 스크립트는 수정하지 않았습니다.

원복하려면 `index.html`의 아래 한 줄을 삭제하거나 주석 처리하면 됩니다.

```html
<link rel="stylesheet" href="css/pwa-home-refresh.css?v=2" />
```

배너 스와이프까지 완전히 원복하려면 아래 스크립트 링크도 삭제합니다.

```html
<script src="js/pwa-home-refresh.js?v=2"></script>
```

다시 적용하려면 스타일 링크는 `styles.css` 바로 다음에, 스크립트 링크는 `js/home.js` 바로 다음에 복원합니다.
