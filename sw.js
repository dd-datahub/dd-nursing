// sw.js — Service Worker "เปล่า" สำหรับ DD Nursing Home (index / staff / staffud)
//
// วัตถุประสงค์เดียว: ทำให้ Android/Chrome จัดเว็บนี้เป็น PWA ที่ "ติดตั้งได้" แบบสมบูรณ์
// เพื่อให้ไอคอนที่ "เพิ่มไปยังหน้าจอหลัก" เปิดแบบ standalone (ไม่มี URL bar)
//
// ตัวนี้ไม่แคชไฟล์ใดๆ ทั้งสิ้น — ทุก request ยังวิ่งไปขอจาก network ตามปกติทุกครั้ง
// เหมือนไม่มี Service Worker อยู่เลยในทางพฤติกรรม (เพื่อเลี่ยงปัญหาแอพค้างเวอร์ชั่นเก่า)

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // ส่งต่อไป network ตรงๆ ไม่ดักจับ ไม่เก็บแคชใดๆ
  event.respondWith(fetch(event.request));
});
