// Service worker mínimo: permite mostrar notificaciones del sistema (también en Android) y abrir la app al pulsarlas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const enlace = (e.notification.data && e.notification.data.enlace) || '#/envios';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(x => 'focus' in x);
    if (c) { c.postMessage({ irA: enlace }); return c.focus(); }
    return self.clients.openWindow('/' + enlace);
  }));
});
