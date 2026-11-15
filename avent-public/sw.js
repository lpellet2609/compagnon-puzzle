// Service worker minimal, uniquement pour permettre l'ajout à l'écran d'accueil. Aucune mise en cache, aucune donnée.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
