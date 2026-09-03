/* Service Worker de Agenda
   - Cachea los archivos de la app para que funcione sin conexión.
   - Intenta generar la notificación resumen de las 7 a.m. usando
     Periodic Background Sync (si el navegador lo soporta).
   IMPORTANTE: esto NO garantiza el envío si el navegador está
   completamente cerrado o el dispositivo apagado. Ver el aviso
   de limitaciones dentro de la app (pie de página).
   - Además importa el Service Worker de OneSignal para que los push
     reales (que sí llegan con la app cerrada) se muestren desde aquí
     mismo, sin registrar un segundo Service Worker aparte. */

importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

const CACHE_NAME = 'agenda-cache-v4';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => cached);
    })
  );
});

/* ---------- IndexedDB access from within the service worker ---------- */
const DB_NAME = 'agenda-db';
const DB_VERSION = 1;
const STORE = 'tasks';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('fecha', 'fecha');
        store.createIndex('estado', 'estado');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllTasks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

async function checkAndNotify() {
  const now = new Date();
  // Solo actuar si estamos dentro de la ventana horaria de las 7 a.m.
  if (now.getHours() !== 7) return;

  const tasks = await getAllTasks();
  const dueToday = tasks.filter((t) => t.estado === 'pendiente' && isSameDay(new Date(t.fecha), now));
  if (dueToday.length === 0) return;

  dueToday.sort((a, b) => (b.alerta ? 1 : 0) - (a.alerta ? 1 : 0));
  const lines = dueToday.slice(0, 5).map((t) => (t.alerta ? '🔔 ' : '• ') + t.titulo);
  const body = lines.join('\n') + (dueToday.length > 5 ? `\n… y ${dueToday.length - 5} más` : '');

  await self.registration.showNotification(`Tienes ${dueToday.length} tarea(s) para hoy`, {
    body,
    icon: 'icon.svg',
    tag: 'agenda-daily-summary',
  });
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'agenda-daily-check') {
    event.waitUntil(checkAndNotify());
  }
});

// Algunos navegadores exponen una API experimental equivalente para
// apps aún no instaladas ('sync' en lugar de 'periodicsync').
self.addEventListener('sync', (event) => {
  if (event.tag === 'agenda-daily-check') {
    event.waitUntil(checkAndNotify());
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
