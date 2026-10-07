// PlanProof admin — service worker. Its only job is to make the admin page installable as an
// app on a phone. It has NO fetch handler and caches NOTHING: every request goes straight to the
// network as normal, and no client records are ever stored on the device.
// (Push notifications for new requests will be added here later — planned after player item 4.)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
