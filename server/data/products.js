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
  { id: "baekil", name: "백일떡", category: "행사", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-representative-baekseolgi.png", detailImages: ["assets/products/4b1e87ce-71c4-4bc1-951e-cc9b12d118d1.png", "assets/products/f3127efa-1286-425a-ab04-935b7e8209ea.png", "assets/products/04_warm_ricecake_storage_1200x800.webp"], description: "기념일 구성 상담 가능", displayOrder: 1 },
  { id: "susupat", name: "수수팥떡", category: "행사", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-representative-susupat.png", detailImages: [
    "assets/products/dcf22bf8-066a-4395-9989-63175c5c3b29.png",
    "assets/products/d916acbb-0d51-4b54-85fe-454f4ec4f91f.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "아이 행사 대표 메뉴", displayOrder: 2 },
  { id: "gift-box", name: "답례떡", category: "답례", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-representative-gift-box.png", description: "개별 포장 상담 가능", displayOrder: 3 },
  { id: "bulk-order", name: "단체주문", category: "답례", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-representative-bulk-order.png", description: "행사 수량 맞춤 구성", displayOrder: 4 },
  { id: "songpyeon-sesame", name: "깨송편", category: "송편", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-songpyeon-sesame.png", detailImages: [
    "assets/products/d7f9ef25-88cc-4dcf-886b-98533133e48e.png",
    "assets/products/e35d4e5c-cd15-47de-833a-47e890826998.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "고소한 깨소 송편", displayOrder: 5 },
  { id: "songpyeon-reserve", name: "송편 예약", category: "송편", purchaseType: "consultation", price: null, imageUrl: "assets/products/menu-representative-songpyeon-sesame.png", detailImages: [
    "assets/products/d7f9ef25-88cc-4dcf-886b-98533133e48e.png",
    "assets/products/e35d4e5c-cd15-47de-833a-47e890826998.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "시즌 예약 상담", displayOrder: 6 },
  { id: "baekseolgi", name: "백설기", category: "행사", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-representative-baekseolgi.png", detailImages: [
    "assets/products/4b1e87ce-71c4-4bc1-951e-cc9b12d118d1.png",
    "assets/products/f3127efa-1286-425a-ab04-935b7e8209ea.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "기념일 구성 상담 가능", displayOrder: 7 },
  { id: "garaetteok", name: "가래떡", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-representative-garaetteok.png", detailImages: [
    "assets/products/d0743a16-05a0-4177-9ddd-8c39f9417929.png",
    "assets/products/6aa807f1-2ec5-43db-a175-8ee518beaf88.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "쫄깃한 기본 떡", displayOrder: 8 },
  { id: "white-jeolpyeon", name: "흰절편", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-representative-white-jeolpyeon.png", detailImages: [
    "assets/products/5d9898cf-329a-422a-957e-358341f0b3f5.png",
    "assets/products/ba15f8ce-4ba3-4b1e-ab7c-5bcd603392a5.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "담백한 절편", displayOrder: 9 },
  { id: "mugwort-jeolpyeon", name: "쑥절편", category: "기본떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-mugwort-jeolpyeon.png", detailImages: [
    "assets/products/0919f321-a27e-4e58-aa1e-adc8ba03adb2.png",
    "assets/products/8a7802fd-9fdd-4eec-bb29-3417c0e852f1.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "쑥 향을 담은 절편", displayOrder: 10 },
  { id: "mugwort-gaetteok", name: "쑥개떡", category: "기본떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-mugwort-gaetteok.png", description: "정겨운 쑥떡", displayOrder: 11 },
  { id: "kongpyeon", name: "콩설기", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-representative-kongpyeon.png", detailImages: [
    "assets/products/5bf63955-3fce-4228-baad-ea6b55da9fe3.png",
    "assets/products/1e393877-5fcf-43b4-811f-f0683f2477f6.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "고소한 콩 떡", displayOrder: 12 },
  { id: "chapssaltteok", name: "찹쌀떡", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-representative-chapssaltteok.png", detailImages: [
    "assets/products/dc20fb1c-30e8-4d19-b15c-6d0f6b7406f3.png",
    "assets/products/fa08e482-7590-4b36-9a7c-aaf026e0f141.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "쫀득한 간식 떡", displayOrder: 13 },
  { id: "yaksik", name: "약식", category: "기본떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-yaksik.png", detailImages: [
    "assets/products/ad61d6ad-d8ab-421d-991f-4245400babee.png",
    "assets/products/88d15354-f718-4855-aaac-50fb8d26e775.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "달콤한 찰밥 떡", displayOrder: 14 },
  { id: "honey-tteok", name: "꿀떡", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-representative-honey-tteok.png", detailImages: [
    "assets/products/a261657c-70df-4f56-b928-e9ae2040c610.png",
    "assets/products/eb6e91cc-4a01-4b6e-b9d4-181725ccf927.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "달콤한 한입 떡", displayOrder: 15 },
  { id: "fruit-gyeongdan", name: "과일경단", category: "기본떡", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-representative-fruit-gyeongdan.png", detailImages: [
    "assets/products/6324073c-6cce-43cf-9821-e87e1735c7db.png",
    "assets/products/1fb560c5-0e85-46ec-ad7e-ca60ada049a8.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "색감 좋은 경단", displayOrder: 16 },
  { id: "honey-seolgi", name: "꿀설기", category: "설기", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-representative-honey-seolgi.png", detailImages: [
    "assets/products/c5c333ea-c8ed-4904-a2d2-ecf71b3e5cbc.png",
    "assets/products/19e021ac-9cd6-4a3e-a312-956c88573e90.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "부드럽고 달콤한 설기", displayOrder: 17 },
  { id: "watermelon-seolgi", name: "수박설기", category: "설기", purchaseType: "direct", price: 3000, imageUrl: "assets/products/menu-watermelon-seolgi.png", description: "귀여운 모양 설기", displayOrder: 18 },
  { id: "mugwort-seolgi", name: "쑥설기", category: "설기", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-mugwort-seolgi.png", detailImages: [
    "assets/products/7540a1df-9707-43ba-ba69-33b3b6a9e574.png",
    "assets/products/4bd82a2c-c0b4-4f0e-ad75-5a77d91ff878.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "쑥 향이 좋은 설기", displayOrder: 19 },
  { id: "blackrice-pumpkin-sand", name: "흑미호박샌드", category: "설기", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-blackrice-pumpkin-sand.png", detailImages: [
    "assets/products/0d971d42-25c9-4578-80de-e3bb562e2d79.png",
    "assets/products/ca2c9bd7-c6d2-489d-a916-45cf97443554.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "식감이 좋은 샌드 떡", displayOrder: 20 },
  { id: "assorted-seolgi", name: "잡과병 모듬설기", category: "설기", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-assorted-seolgi.png", description: "여러 재료가 어우러진 설기", displayOrder: 21 },
  { id: "injeolmi", name: "인절미", category: "인절미", purchaseType: "direct", price: 3500, imageUrl: "assets/products/menu-representative-injeolmi.png", detailImages: [
    "assets/products/623c9630-0bad-4f61-b725-7820d9e38c3f.png",
    "assets/products/248444ce-5ca6-4439-b181-61104d484075.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "고소한 기본 인절미", displayOrder: 22 },
  { id: "mugwort-injeolmi", name: "쑥인절미", category: "인절미", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-mugwort-injeolmi.png", detailImages: [
    "assets/products/a905553a-1190-45bd-a8f0-d8c6a6000cff.png",
    "assets/products/514cb29d-e4d1-402e-9132-975d39d4020e.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "쑥 향과 고소함", displayOrder: 23 },
  { id: "castella-injeolmi", name: "카스테라 인절미", category: "인절미", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-castella-injeolmi.png", detailImages: [
    "assets/products/21b8b9ab-6b91-492a-b709-ea64d0e5fab4.png",
    "assets/products/3454247f-efc6-4563-b87a-8e77956762a6.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "부드러운 카스테라 가루", displayOrder: 24 },
  { id: "black-sesame-injeolmi", name: "흑임자 인절미", category: "인절미", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-black-sesame-injeolmi.png", detailImages: [
    "assets/products/72fe0bfb-5df0-4a09-acdd-57192c21b3d6.png",
    "assets/products/8946eaf1-02cf-44b4-b9ef-26b7201ca595.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "진한 흑임자 고소함", displayOrder: 25 },
  { id: "chal-sirutteok", name: "찰시루떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-chal-sirutteok.png", detailImages: [
    "assets/products/8b079e86-2fda-442d-aa82-c0712d2d5d06.png",
    "assets/products/1337b2ba-22ea-4173-8b70-563b9c903553.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "든든한 찰떡", displayOrder: 26 },
  { id: "pea-chaltteok", name: "완두배기 찰떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-representative-pea-chaltteok.png", detailImages: [
    "assets/products/fd8ed4b3-26a1-4202-afd1-73b5d71464a5.png",
    "assets/products/2b3e4405-c41a-4caa-9488-a68828ad0024.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "완두의 식감", displayOrder: 27 },
  { id: "bean-chaltteok", name: "콩찰떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-bean-chaltteok.png", description: "고소한 콩의 맛", displayOrder: 28 },
  { id: "pumpkin-chaltteok", name: "호박찰떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-pumpkin-chaltteok.png", description: "달큰한 호박 풍미", displayOrder: 29 },
  { id: "nut-chaltteok", name: "견과류찰떡", category: "찰떡", purchaseType: "direct", price: 4000, imageUrl: "assets/products/menu-nut-chaltteok.png", description: "견과류가 씹히는 찰떡", displayOrder: 30 },
  { id: "assorted-chaltteok", name: "모듬찰떡", category: "찰떡", purchaseType: "direct", price: 4000, unitWeightGrams: 230, imageUrl: "assets/products/menu-representative-assorted-chaltteok.png", detailImages: [
    "assets/products/c843c321-397a-4ece-a628-3706fa4f7a3f.png",
    "assets/products/2a1ee0a9-5fac-43aa-a889-6d59a77a0680.png",
    "assets/products/16cd5755-9a6f-411d-8cf8-1d93d9dff89a.png",
    "assets/products/04_warm_ricecake_storage_1200x800.webp",
  ], description: "단호박과 밤, 팥, 검은콩을 넉넉히 넣어 만든 수제 모듬찰떡", displayOrder: 31 },
];
