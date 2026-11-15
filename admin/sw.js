// PlanProof admin — service worker. It makes the admin page installable as an app on a
// phone and (W8 build 2, 15 November 2026) shows PlanProof's push alerts. It has NO fetch
// handler and caches NOTHING: every request goes straight to the network as normal, and no
// client records are ever stored on the device. (A test asserts there is no fetch handler.)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// An alert: the title, the next-action line, the request to open. The text is all there is;
// opening it re-reads the request from the database (nothing is taken from the alert itself).
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "PlanProof", body: e.data ? e.data.text() : "" }; }
  const title = d.title || "PlanProof";
  const shown = self.registration.showNotification(title, {
    body: d.body || "Open the admin page.",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: d.url || "/admin/" },
  });
  // The app icon shows a dot until the page is opened (the page then sets the real number).
  const badge = self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => {}) : Promise.resolve();
  e.waitUntil(Promise.all([shown, badge]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "/admin/", self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).pathname.startsWith("/admin/")) {
        await c.focus();
        try { await c.navigate(target); } catch { c.postMessage({ type: "open", url: target }); }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
