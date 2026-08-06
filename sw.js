// MTSLONG 站点 Service Worker
// 策略：precache 核心静态资源 + runtime cache（cache-first，命中回退；网络回填）
const CACHE = "mtslong-v1";
const PRECACHE = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/site.webmanifest",
  "/assets/favicon-32.png",
  "/assets/favicon-48.png",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
  "/assets/maskable-icon-512.png",
  "/assets/apple-touch-icon.png",
  "/assets/mtslong-hero.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // 后台回填（stale-while-revalidate 风格，但优先缓存）
        fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match("/index.html"));
    })
  );
});
