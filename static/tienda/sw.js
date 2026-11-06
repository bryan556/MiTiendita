// ==========================================
//  SERVICE WORKER - MiTiendita PWA
//  Fase 1: Cacheo de archivos estáticos
//  Fase 2: Pantalla de facturación offline (datos en IndexedDB)
//  Fase 3: Sincronización de ventas con el servidor
// ==========================================

const CACHE_VERSION = 'mitiendita-v1.3.0';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;

// Archivos que se cachean al instalar (críticos para que funcione)
const ARCHIVOS_CRITICOS = [
    '/',
    '/facturacion/',
    '/productos/',
    'proveedores',
    '/clientes/',
    '/static/tienda/manifest.json',
    '/static/tienda/offline.html',
    // --- Fase 2: todo lo necesario para vender sin conexión ---
    '/facturacion/offline/',
    '/static/tienda/offline-db.js',
    '/static/tienda/facturacion-offline.js',
    '/static/bootstrap/css/bootstrap.min.css',
    '/static/bootstrap/js/bootstrap.bundle.min.js',
    '/static/fontawesome/css/all.min.css',
];

const URL_FACTURACION = '/facturacion/';
const URL_FACTURACION_OFFLINE = '/facturacion/offline/';

// Guarda en caché solo respuestas válidas y NO redirigidas. Si la sesión
// expiró, el servidor redirige al login y Chrome no permite servir una
// respuesta redirigida a una navegación: mejor no guardarla.
function cachearSiValida(cache, url) {
    // cache:'reload' = saltarse la caché HTTP del navegador (evita guardar JS viejo en el precaché)
    return fetch(url, { credentials: 'same-origin', cache: 'reload' }).then((resp) => {
        if (resp && resp.ok && !resp.redirected) {
            return cache.put(url, resp);
        }
        console.warn(`[SW] No se cacheó ${url} (estado ${resp && resp.status}, redirigida: ${resp && resp.redirected})`);
    });
}

// ==========================================
//  1. INSTALACIÓN - Cachear archivos críticos
// ==========================================
self.addEventListener('install', (event) => {
    console.log('[SW] Instalando Service Worker...');
    
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                console.log('[SW] Cacheando archivos críticos');
                // Usamos addAll pero con manejo de errores individual
                return Promise.allSettled(
                    ARCHIVOS_CRITICOS.map(url => 
                        cachearSiValida(cache, url).catch(err => 
                            console.warn(`[SW] No se pudo cachear ${url}:`, err)
                        )
                    )
                );
            })
            .then(() => {
                console.log('[SW] Instalación completa');
                return self.skipWaiting(); // Activar inmediatamente
            })
    );
});

// ==========================================
//  2. ACTIVACIÓN - Limpiar cachés viejas
// ==========================================
self.addEventListener('activate', (event) => {
    console.log('[SW] Activando Service Worker...');
    
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name !== STATIC_CACHE && name !== DYNAMIC_CACHE)
                        .map((name) => {
                            console.log('[SW] Borrando caché vieja:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => self.clients.claim()) // Tomar control inmediatamente
    );
});

// ==========================================
//  3. FETCH - Estrategia de cacheo
// ==========================================
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // No cachear peticiones a otros dominios (APIs externas, etc.)
    if (url.origin !== location.origin) {
        return;
    }
    
    // No cachear peticiones POST, PUT, DELETE (solo GET)
    if (request.method !== 'GET') {
        // Excepción: si es POST a /facturacion/guardar/ y falla, guardar offline
        // (esto lo implementaremos en Fase 3)
        return;
    }
    
    // No cachear peticiones de polling del escáner (siempre deben ir al servidor)
    if (url.pathname.includes('/escaner/consultar/') || 
        url.pathname.includes('/escaner/verificar/')) {
        return;
    }
    
    // No cachear el admin de Django
    if (url.pathname.startsWith('/admin/')) {
        return;
    }

    // No cachear las APIs (catálogo, etc.): los datos offline viven en IndexedDB
    if (url.pathname.startsWith('/api/')) {
        return;
    }
    
    // Estrategia: Network First con fallback a cache
    // (intenta red primero, si falla usa cache)
    // Los archivos estáticos se revalidan SIEMPRE con el servidor (cache:'no-cache'). Sin esto, la caché
    // HTTP del navegador puede entregar un JS/CSS viejo aunque ya hayas copiado la versión nueva.
    const peticion = request.mode === 'navigate' ? fetch(request) : fetch(request, { cache: 'no-cache' });

    event.respondWith(
        peticion
            .then((response) => {
                // Si la respuesta es válida, guardar copia en cache dinámico
                if (response && response.status === 200 && !response.redirected) {
                    const responseClone = response.clone();
                    caches.open(DYNAMIC_CACHE).then((cache) => {
                        cache.put(request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Sin internet en la pantalla de facturación normal: usar la versión offline
                // (la normal depende del servidor para cada clic y no funcionaría)
                if (request.mode === 'navigate' && url.pathname === URL_FACTURACION) {
                    return caches.match(URL_FACTURACION_OFFLINE).then((offlinePage) => {
                        return offlinePage || caches.match('/static/tienda/offline.html');
                    });
                }

                // Sin internet: buscar en cache
                return caches.match(request)
                    .then((cachedResponse) => {
                        if (cachedResponse) {
                            return cachedResponse;
                        }
                        
                        // Si es una navegación (HTML), mostrar página offline
                        if (request.mode === 'navigate') {
                            return caches.match('/static/tienda/offline.html');
                        }
                        
                        // Si es una imagen, devolver placeholder
                        if (request.destination === 'image') {
                            return new Response(
                                '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ddd"/><text x="50" y="50" font-size="12" text-anchor="middle" fill="#999">Sin imagen</text></svg>',
                                { headers: { 'Content-Type': 'image/svg+xml' } }
                            );
                        }
                        
                        // Para otros recursos, devolver error
                        return new Response('Recurso no disponible offline', {
                            status: 503,
                            headers: { 'Content-Type': 'text/plain' }
                        });
                    });
            })
    );
});

// ==========================================
//  4. MENSAJES desde el cliente
// ==========================================
self.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data && event.data.tipo === 'LIMPIAR_CACHE') {
        caches.keys().then((names) => {
            names.forEach((name) => caches.delete(name));
        });
    }
});

console.log('[SW] Service Worker cargado correctamente');