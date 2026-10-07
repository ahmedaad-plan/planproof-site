// PlanProof admin — service worker. Its only job is to make the admin page installable as an
// app on a phone. It deliberately caches NOTHING: client records are confidential, so every
// request always goes to the network and nothing is stored on the device.
// (Push notifications for new requests will be added here later — planned after player item 4.)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => { e.respondWith(fetch(e.request)); });
