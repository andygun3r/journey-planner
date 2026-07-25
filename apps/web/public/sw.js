/* Mainline service worker — Web Push for commute disruption alerts. */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: "Mainline", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Mainline";
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
