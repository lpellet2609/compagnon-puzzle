// Service worker minimal : rend l'appli installable (et servira aux notifications du soir).
// Aucune mise en cache : tout vient toujours du serveur, pour que les mises à jour arrivent tout de suite.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Rappel du soir : affichage de la notification, puis ouverture de la fenêtre du jour au toucher
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Le Betlehem des Anges', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
