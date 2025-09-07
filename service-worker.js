/**
 * Sierra Sync Platform Service Worker
 * Provides offline support and caching strategies
 */

const CACHE_NAME = 'sierra-sync-v1.0.0';
const DYNAMIC_CACHE = 'sierra-sync-dynamic-v1.0.0';
const API_CACHE = 'sierra-sync-api-v1.0.0';

// Assets to cache on install
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/login.html',
    '/main-dashboard.html',
    '/analytics-dashboard.html',
    '/dashboard.html',
    '/profile.html',
    '/offline.html',
    '/src/js/auth.js',
    '/src/js/mobile-nav.js',
    '/src/js/responsive-table.js',
    '/src/js/responsive-charts.js',
    '/manifest.json',
    'https://cdn.tailwindcss.com',
    'https://unpkg.com/lucide@latest/dist/umd/lucide.js',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing...');
    
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[Service Worker] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activating...');
    
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(cacheName => {
                        return cacheName.startsWith('sierra-sync-') &&
                               cacheName !== CACHE_NAME &&
                               cacheName !== DYNAMIC_CACHE &&
                               cacheName !== API_CACHE;
                    })
                    .map(cacheName => {
                        console.log('[Service Worker] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch event - serve from cache or network
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }
    
    // API requests - network first, cache fallback
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirstStrategy(request));
        return;
    }
    
    // Static assets - cache first, network fallback
    if (isStaticAsset(request.url)) {
        event.respondWith(cacheFirstStrategy(request));
        return;
    }
    
    // HTML pages - network first for freshness
    if (request.headers.get('accept').includes('text/html')) {
        event.respondWith(networkFirstStrategy(request));
        return;
    }
    
    // Default - try cache, then network
    event.respondWith(cacheFirstStrategy(request));
});

// Cache first strategy
async function cacheFirstStrategy(request) {
    try {
        const cache = await caches.open(CACHE_NAME);
        const cachedResponse = await cache.match(request);
        
        if (cachedResponse) {
            // Update cache in background if online
            if (navigator.onLine) {
                updateCache(request, CACHE_NAME);
            }
            return cachedResponse;
        }
        
        // Not in cache, fetch from network
        const networkResponse = await fetch(request);
        
        // Cache successful responses
        if (networkResponse.ok) {
            const responseToCache = networkResponse.clone();
            cache.put(request, responseToCache);
        }
        
        return networkResponse;
    } catch (error) {
        console.error('[Service Worker] Fetch failed:', error);
        
        // Return offline page for navigation requests
        if (request.mode === 'navigate') {
            return caches.match('/offline.html');
        }
        
        // Return placeholder for other requests
        return new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable'
        });
    }
}

// Network first strategy
async function networkFirstStrategy(request) {
    const cache = await caches.open(DYNAMIC_CACHE);
    
    try {
        const networkResponse = await fetch(request);
        
        // Cache successful responses
        if (networkResponse.ok) {
            const responseToCache = networkResponse.clone();
            cache.put(request, responseToCache);
        }
        
        return networkResponse;
    } catch (error) {
        console.error('[Service Worker] Network request failed:', error);
        
        // Try cache
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        
        // Return offline page for navigation requests
        if (request.mode === 'navigate') {
            return caches.match('/offline.html');
        }
        
        // Return error response
        return new Response('Network error', {
            status: 503,
            statusText: 'Service Unavailable'
        });
    }
}

// Update cache in background
async function updateCache(request, cacheName) {
    try {
        const cache = await caches.open(cacheName);
        const networkResponse = await fetch(request);
        
        if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
        }
    } catch (error) {
        console.log('[Service Worker] Background update failed:', error);
    }
}

// Check if URL is a static asset
function isStaticAsset(url) {
    const staticExtensions = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2'];
    return staticExtensions.some(ext => url.includes(ext));
}

// Handle background sync
self.addEventListener('sync', (event) => {
    console.log('[Service Worker] Background sync:', event.tag);
    
    if (event.tag === 'sync-data') {
        event.waitUntil(syncData());
    }
});

// Sync data when back online
async function syncData() {
    try {
        // Get pending data from IndexedDB or localStorage
        const pendingData = await getPendingData();
        
        if (pendingData && pendingData.length > 0) {
            // Send pending data to server
            const response = await fetch('/api/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(pendingData)
            });
            
            if (response.ok) {
                // Clear pending data
                await clearPendingData();
                
                // Notify clients
                self.clients.matchAll().then(clients => {
                    clients.forEach(client => {
                        client.postMessage({
                            type: 'SYNC_COMPLETE',
                            message: 'Data synchronized successfully'
                        });
                    });
                });
            }
        }
    } catch (error) {
        console.error('[Service Worker] Sync failed:', error);
    }
}

// Get pending data (placeholder - implement with IndexedDB)
async function getPendingData() {
    // This would typically fetch from IndexedDB
    return [];
}

// Clear pending data (placeholder - implement with IndexedDB)
async function clearPendingData() {
    // This would typically clear IndexedDB
    return true;
}

// Handle push notifications
self.addEventListener('push', (event) => {
    console.log('[Service Worker] Push received');
    
    let data = {
        title: 'Sierra Sync',
        body: 'You have a new notification',
        icon: '/icons/icon-192x192.png',
        badge: '/icons/badge-72x72.png'
    };
    
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }
    
    const options = {
        body: data.body,
        icon: data.icon || '/icons/icon-192x192.png',
        badge: data.badge || '/icons/badge-72x72.png',
        vibrate: [200, 100, 200],
        data: data,
        actions: [
            {
                action: 'view',
                title: 'View',
                icon: '/icons/check.png'
            },
            {
                action: 'dismiss',
                title: 'Dismiss',
                icon: '/icons/cross.png'
            }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
    console.log('[Service Worker] Notification clicked:', event.action);
    
    event.notification.close();
    
    if (event.action === 'view' || !event.action) {
        // Open the app or focus existing window
        event.waitUntil(
            clients.matchAll({ type: 'window' }).then(clientList => {
                for (const client of clientList) {
                    if (client.url === '/' && 'focus' in client) {
                        return client.focus();
                    }
                }
                if (clients.openWindow) {
                    return clients.openWindow('/');
                }
            })
        );
    }
});

// Handle messages from clients
self.addEventListener('message', (event) => {
    console.log('[Service Worker] Message received:', event.data);
    
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data.type === 'CLEAR_CACHE') {
        event.waitUntil(
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => caches.delete(cacheName))
                );
            }).then(() => {
                event.ports[0].postMessage({ success: true });
            })
        );
    }
});