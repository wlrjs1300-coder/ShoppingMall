// menu.html의 30개 상품(.menu-item)을 그대로 옮긴 초기 시드 데이터.
// id는 기존 .image-* CSS 클래스명을 참고했지만 동일한 개념이 아니다 — 두 상품(songpyeon-sesame/
// songpyeon-reserve)이 image-songpyeon 클래스 하나를 공유하는 것처럼 CSS 슬러그와 상품 ID는
// 1:1이 아닐 수 있어 각 상품마다 명시적으로 부여했다.
//
// display_order는 menu.html에 실제 나타나는 DOM 순서(=화면 표시 순서) 그대로다.
//
// image_url은 원칙적으로 각 상품의 .image-* 클래스가 가리키는 1순위 배경 이미지 파일이지만,
// black-sesame-injeolmi 상품만 예외다: CSS의 1순위 파일(menu-black-sesame-injeolmi.png)이
// 실제로 assets/products/에 존재하지 않아(깨진 참조), 실제로 존재하는 2순위(폴백) 파일인
// black-sesame-injeolmi.jpg를 사용했다. (검증 결과는 보고서 K항목 참고)
module.exports = [
  { id: "baekil", name: "백일떡", category: "행사", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-baekil.png", description: "기념일 구성 상담 가능", displayOrder: 1 },
  { id: "susupat", name: "수수팥떡", category: "행사", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-susupat.png", description: "아이 행사 대표 메뉴", displayOrder: 2 },
  { id: "gift-box", name: "답례떡", category: "답례", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-gift-box.png", description: "개별 포장 상담 가능", displayOrder: 3 },
  { id: "bulk-order", name: "단체주문", category: "답례", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-bulk-order.png", description: "행사 수량 맞춤 구성", displayOrder: 4 },
  { id: "songpyeon-sesame", name: "깨송편", category: "송편", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-songpyeon.png", description: "고소한 깨소 송편", displayOrder: 5 },
  { id: "songpyeon-reserve", name: "송편 예약", category: "송편", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-songpyeon.png", description: "시즌 예약 상담", displayOrder: 6 },
  { id: "garaetteok", name: "가래떡", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-garaetteok.png", description: "쫄깃한 기본 떡", displayOrder: 7 },
  { id: "white-jeolpyeon", name: "흰절편", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-white-jeolpyeon.png", description: "담백한 절편", displayOrder: 8 },
  { id: "mugwort-jeolpyeon", name: "쑥절편", category: "기본떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-mugwort-jeolpyeon.png", description: "쑥 향을 담은 절편", displayOrder: 9 },
  { id: "mugwort-gaetteok", name: "쑥개떡", category: "기본떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-mugwort-gaetteok.png", description: "정겨운 쑥떡", displayOrder: 10 },
  { id: "kongpyeon", name: "콩편", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-kongpyeon.png", description: "고소한 콩 떡", displayOrder: 11 },
  { id: "chapssaltteok", name: "찹쌀떡", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-chapssaltteok.png", description: "쫀득한 간식 떡", displayOrder: 12 },
  { id: "yaksik", name: "약식", category: "기본떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-yaksik.png", description: "달콤한 찰밥 떡", displayOrder: 13 },
  { id: "honey-tteok", name: "꿀떡", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-honey-tteok.png", description: "달콤한 한입 떡", displayOrder: 14 },
  { id: "fruit-gyeongdan", name: "과일경단", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-fruit-gyeongdan.png", description: "색감 좋은 경단", displayOrder: 15 },
  { id: "honey-seolgi", name: "꿀설기", category: "설기", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-honey-seolgi.png", description: "부드럽고 달콤한 설기", displayOrder: 16 },
  { id: "watermelon-seolgi", name: "수박설기", category: "설기", purchaseType: "direct", price: 3000, imageUrl: "assets/products/menu-watermelon-seolgi.png", description: "귀여운 모양 설기", displayOrder: 17 },
  { id: "mugwort-seolgi", name: "쑥설기", category: "설기", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-mugwort-seolgi.png", description: "쑥 향이 좋은 설기", displayOrder: 18 },
  { id: "blackrice-pumpkin-sand", name: "흑미호박샌드", category: "설기", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-blackrice-pumpkin-sand.png", description: "식감이 좋은 샌드 떡", displayOrder: 19 },
  { id: "assorted-seolgi", name: "잡과병 모듬설기", category: "설기", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-assorted-seolgi.png", description: "여러 재료가 어우러진 설기", displayOrder: 20 },
  { id: "injeolmi", name: "인절미", category: "인절미", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-injeolmi.png", description: "고소한 기본 인절미", displayOrder: 21 },
  { id: "mugwort-injeolmi", name: "쑥인절미", category: "인절미", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-mugwort-injeolmi.png", description: "쑥 향과 고소함", displayOrder: 22 },
  { id: "castella-injeolmi", name: "카스테라 인절미", category: "인절미", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-castella-injeolmi.png", description: "부드러운 카스테라 가루", displayOrder: 23 },
  { id: "black-sesame-injeolmi", name: "흑임자 인절미", category: "인절미", purchaseType: "direct", price: 4000, imageUrl: "assets/products/black-sesame-injeolmi.jpg", description: "진한 흑임자 고소함", displayOrder: 24 },
  { id: "chal-sirutteok", name: "찰시루떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-chal-sirutteok.png", description: "든든한 찰떡", displayOrder: 25 },
  { id: "pea-chaltteok", name: "완두배기 찰떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-pea-chaltteok.png", description: "완두의 식감", displayOrder: 26 },
  { id: "bean-chaltteok", name: "콩찰떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-bean-chaltteok.png", description: "고소한 콩의 맛", displayOrder: 27 },
  { id: "pumpkin-chaltteok", name: "호박찰떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-pumpkin-chaltteok.png", description: "달큰한 호박 풍미", displayOrder: 28 },
  { id: "nut-chaltteok", name: "견과류찰떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-nut-chaltteok.png", description: "견과류가 씹히는 찰떡", displayOrder: 29 },
  { id: "assorted-chaltteok", name: "모듬찰떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-assorted-chaltteok.png", description: "다양하게 즐기는 찰떡", displayOrder: 30 },
];
