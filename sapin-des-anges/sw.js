// Service worker minimal : rend l'appli installable (et servira aux notifications du soir).
// Aucune mise en cache : tout vient toujours du serveur, pour que les mises à jour arrivent tout de suite.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
