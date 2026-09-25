/// <reference lib="webworker" />
// Service worker of Hypatia's Hoard: precache the built app and serve its shell for
// navigations. The local server owns /api/*, /resources/* and /question-images/*:
// those always go to the network.
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//, /^\/resources\//, /^\/question-images\//],
  }),
);
