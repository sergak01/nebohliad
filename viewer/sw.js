'use strict';

// Only for browser notifications from the viewer page (Android Chrome shows
// them through a service worker). No fetch handler: it never touches the
// streams or any other request.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Tapping a notification brings the viewer page to the front.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const page = list.find((client) => 'focus' in client);
      return page ? page.focus() : undefined;
    }),
  );
});
