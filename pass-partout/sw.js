// Pass-partout : l'appli s'ouvre même sans réseau (les données viennent du cache Firestore).
const VERSION = "pp-26";
const SHELL = ["./", "index.html", "style.css", "app.js", "view.js", "importer.js", "cards.js", "ndf.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === location.origin && url.pathname.startsWith("/pass-partout/");
  const static3p = url.hostname === "www.gstatic.com" || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com") || url.hostname === "cdn.jsdelivr.net";
  if (!same && !static3p) return; // Firestore, Auth : laissés au SDK
  // Réseau d'abord pour l'appli (mises à jour immédiates), cache si hors ligne
  // ou si le réseau traîne plus de 3 s (wifi d'avion, portail captif, zone blanche).
  const fromCache = () => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === "navigate" ? caches.match("index.html") : null));
  const net = fetch(req).then((res) => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  });
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const t = setTimeout(() => fromCache().then(finish), 3000);
    net.then((r) => { clearTimeout(t); finish(r); })
      .catch(() => { clearTimeout(t); fromCache().then((r) => r ? finish(r) : (done = true, resolve(Response.error()))); });
  }));
});
