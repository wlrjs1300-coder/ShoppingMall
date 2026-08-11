# PWA 메뉴 상세 UI 원복 안내

메뉴 상세 PWA 시안은 `css/pwa-product-refresh.css`에 분리되어 있습니다.

원복하려면 `product.html`에서 아래 링크 한 줄을 제거합니다.

```html
<link rel="stylesheet" href="css/pwa-product-refresh.css?v=3" />
```

Q&A 출력 구조까지 이전 상태로 되돌리려면 `js/product-detail.js`의 FAQ 질문과 답변 마크업 변경도 함께 되돌려야 합니다.
