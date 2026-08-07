/* Signaller service worker — Web Push (commute alerts) + a minimal offline shell.
 *
 * Caching policy is deliberately conservative because Signaller is a live product:
 * we NEVER serve stale live data. Only static assets are cached, plus a
 * navigation fallback so the app opens (into the search screen) when offline.
 * API responses (boards, journeys, alerts, live-trains) are always network-only.
 */

// Bumping this name is what evicts old entries: `activate` deletes every cache
// whose key !== CACHE. Bump it whenever the caching policy changes.
const CACHE = "signaller-shell-v3";
const SHELL = ["/", "/icon.png", "/icon-192.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache live data or streams — always go to network.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network-first, fall back to the cached app shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/").then((r) => r || Response.error())),
    );
    return;
  }

  // Next's build output is content-hashed and changes every rebuild. Serving it
  // cache-first pinned the browser to stale JS chunks across reloads (a hard
  // refresh bypasses the HTTP cache but NOT the service worker), so the app
  // kept running code from an earlier build. Always go to network for these;
  // the hashed filenames already make them safely HTTP-cacheable.
  if (url.pathname.startsWith("/_next/")) return;

  // Static assets: cache-first.
  if (["style", "script", "image", "font"].includes(req.destination)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          }),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: "Signaller", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Signaller";
  const options = {
    body: data.body || "",
    tag: data.tag,
    data: { url: data.url || "/commute" },
    icon: "/icon.png",
    badge: "/icon.png",
    // Re-alert even if a notification with the same tag exists.
    renotify: Boolean(data.tag),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/commute";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
