// Network-first service worker: every launch gets the latest deployed files (revalidated past the
// HTTP cache), and the last good copy is kept so the games also work offline. Nothing to bump on deploy.
// If the network is slower than TIMEOUT and a cached copy exists, that copy is used (and refreshed in
// the background for next time).
const CACHE = 'games';
const TIMEOUT = 3000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  // Clone synchronously in the first callback registered on `net`, before the page can read the body.
  e.waitUntil(net.then((res) => {
    if (!res.ok || res.redirected) return;
    const copy = res.clone();
    return caches.open(CACHE).then((c) => c.put(req, copy));
  }).catch(() => {}));
  e.respondWith(respond(req, net));
});

async function respond(req, net) {
  const timeout = new Promise((r) => setTimeout(r, TIMEOUT));
  let res = await Promise.race([net.catch(() => null), timeout]); // undefined: timed out, null: failed
  if (!res) {
    const hit = await caches.match(req);
    if (hit) return hit;
    res = await net; // no cached copy: keep waiting (or fail like a normal offline load)
  }
  // e.g. /xtiles -> /xtiles/: navigations must see the redirect so relative URLs resolve correctly.
  if (res.redirected && req.mode === 'navigate') return Response.redirect(res.url, 302);
  return res;
}
