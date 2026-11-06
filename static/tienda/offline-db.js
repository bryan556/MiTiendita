/* ==========================================================
   MiTiendita - Almacenamiento local para modo offline (Fase 2)
   Guarda en IndexedDB: catálogo de productos, ventas pendientes
   y datos auxiliares (meta). Dinero SIEMPRE en centavos enteros.
   ========================================================== */
(function (global) {
    'use strict';

    const DB_NAME = 'mitiendita-offline';
    const DB_VERSION = 1;
    const URL_CATALOGO = '/api/catalogo-offline/';
    const URL_SYNC = '/api/sincronizar-ventas/';
    const TAM_LOTE = 20;
    const DIAS_CONSERVAR_SINCRONIZADAS = 7;
    const URL_FACTURACION = '/facturacion/';
    const URL_FACTURACION_OFFLINE = '/facturacion/offline/';
    const MINUTOS_ENTRE_SYNC = 5;

    let _dbPromise = null;

    function abrir() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('productos')) {
                    db.createObjectStore('productos', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('ventas')) {
                    const s = db.createObjectStore('ventas', { keyPath: 'uuid' });
                    s.createIndex('estado', 'estado', { unique: false });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'clave' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { _dbPromise = null; reject(req.error); };
        });
        return _dbPromise;
    }

    // Ejecuta fn dentro de UNA transacción; resuelve cuando la transacción termina.
    function tx(stores, modo, fn) {
        return abrir().then((db) => new Promise((resolve, reject) => {
            const t = db.transaction(stores, modo);
            let salida;
            t.oncomplete = () => resolve(salida);
            t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
            t.onerror = () => reject(t.error || new Error('Error en transacción'));
            fn(t, (v) => { salida = v; });
        }));
    }

    // ---------- Utilidades ----------
    function aCentavos(texto) {
        const n = Math.round(parseFloat(String(texto).replace(',', '.')) * 100);
        return Number.isFinite(n) ? n : 0;
    }

    function formatoMoneda(centavos) {
        return 'C$ ' + (centavos / 100).toLocaleString('es-NI', {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        });
    }

    // crypto.randomUUID solo existe en contextos seguros (https/localhost);
    // en http://192.168.x.x no, por eso el respaldo con getRandomValues.
    function nuevoUUID() {
        const c = global.crypto;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        const b = new Uint8Array(16);
        c.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }

    // ---------- Meta ----------
    function getMeta(clave) {
        return tx('meta', 'readonly', (t, set) => {
            const r = t.objectStore('meta').get(clave);
            r.onsuccess = () => set(r.result ? r.result.valor : undefined);
        });
    }

    function setMeta(clave, valor) {
        return tx('meta', 'readwrite', (t) => {
            t.objectStore('meta').put({ clave, valor });
        });
    }

    // ---------- Catálogo ----------
    // Reemplaza el catálogo local por el del servidor, pero RESTA lo vendido
    // offline que aún no se ha sincronizado (si no, el stock local "subiría").
    function guardarCatalogo(data) {
        return tx(['productos', 'ventas', 'meta'], 'readwrite', (t) => {
            const rv = t.objectStore('ventas').index('estado').getAll('pendiente');
            rv.onsuccess = () => {
                const reservado = {};
                rv.result.forEach((v) => v.items.forEach((it) => {
                    reservado[it.id] = (reservado[it.id] || 0) + it.cantidad;
                }));

                const sp = t.objectStore('productos');
                sp.clear();
                data.productos.forEach((p) => {
                    sp.put({
                        id: p.id,
                        nombre: p.nombre,
                        precio_cent: aCentavos(p.precio),
                        stock: p.stock - (reservado[p.id] || 0),
                        codigo_barra: p.codigo_barra || ''
                    });
                });

                const sm = t.objectStore('meta');
                sm.put({ clave: 'caja_abierta', valor: !!data.caja_abierta });
                sm.put({ clave: 'usuario', valor: data.usuario || null });
                sm.put({ clave: 'ultima_sync', valor: new Date().toISOString() });
            };
        });
    }

    function obtenerProductos() {
        return tx('productos', 'readonly', (t, set) => {
            const r = t.objectStore('productos').getAll();
            r.onsuccess = () => set(r.result);
        });
    }

    async function sincronizarCatalogo(forzar) {
        if (!navigator.onLine) return { ok: false, motivo: 'offline' };
        try {
            const ultima = await getMeta('ultima_sync');
            if (!forzar && ultima &&
                (Date.now() - new Date(ultima).getTime()) < MINUTOS_ENTRE_SYNC * 60000) {
                return { ok: true, omitido: true };
            }
            const resp = await fetch(URL_CATALOGO, { credentials: 'same-origin', cache: 'no-store' });
            if (resp.status === 401) {
                console.warn('[Offline] Catálogo no descargado: sesión no iniciada (401)');
                return { ok: false, motivo: 'no_autenticado' };
            }
            if (!resp.ok) {
                console.warn('[Offline] Catálogo no descargado: el servidor respondió ' + resp.status);
                return { ok: false, motivo: 'http_' + resp.status };
            }
            const data = await resp.json();
            await guardarCatalogo(data);
            console.log('[Offline] Catálogo descargado: ' + data.productos.length + ' productos');
            return { ok: true };
        } catch (e) {
            console.warn('[Offline] Catálogo no descargado:', e);
            return { ok: false, motivo: 'red' };
        }
    }

    // ---------- Ventas ----------
    // Guarda la venta, descuenta el stock local y asigna el número provisional
    // OFF-0001, OFF-0002... TODO en una sola transacción (o se guarda todo o nada).
    function registrarVenta(venta) {
        return tx(['ventas', 'productos', 'meta'], 'readwrite', (t, set) => {
            const sm = t.objectStore('meta');
            const rc = sm.get('contador_off');
            rc.onsuccess = () => {
                const n = (rc.result ? rc.result.valor : 0) + 1;
                venta.numero_provisional = 'OFF-' + String(n).padStart(4, '0');
                sm.put({ clave: 'contador_off', valor: n });
                t.objectStore('ventas').put(venta);

                const sp = t.objectStore('productos');
                venta.items.forEach((it) => {
                    const rp = sp.get(it.id);
                    rp.onsuccess = () => {
                        if (rp.result) {
                            rp.result.stock -= it.cantidad;
                            sp.put(rp.result);
                        }
                    };
                });
                set(venta);
            };
        });
    }

    function listarVentas(estado) {
        return tx('ventas', 'readonly', (t, set) => {
            const s = t.objectStore('ventas');
            const r = estado ? s.index('estado').getAll(estado) : s.getAll();
            r.onsuccess = () => set(r.result);
        });
    }

    async function contarPendientes() {
        return (await listarVentas('pendiente')).length;
    }

    // ---------- Sincronización de ventas con el servidor ----------
    let _sincronizando = false;

    function leerCookie(nombre) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + nombre + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    // Marca cada venta según lo que respondió el servidor.
    //   sincronizada -> guardada en el servidor (se conserva unos días como historial)
    //   rechazada    -> datos inválidos: NO se reintenta, queda visible con su motivo
    //   error        -> fallo temporal del servidor: sigue "pendiente" y se reintenta
    function aplicarResultados(resultados) {
        return tx('ventas', 'readwrite', (t) => {
            const s = t.objectStore('ventas');
            resultados.forEach((r) => {
                const rg = s.get(r.uuid);
                rg.onsuccess = () => {
                    const v = rg.result;
                    if (!v) return;
                    if (r.estado === 'sincronizada') {
                        v.estado = 'sincronizada';
                        v.id_factura = r.id_factura;
                        v.incidencias = r.incidencias || 0;
                        v.fecha_sync = new Date().toISOString();
                        delete v.motivo;
                    } else if (r.estado === 'rechazada') {
                        v.estado = 'rechazada';
                        v.motivo = r.motivo || 'Rechazada por el servidor';
                    } else {
                        v.ultimo_error = r.motivo || 'Error del servidor';
                    }
                    s.put(v);
                };
            });
        });
    }

    // Borra del equipo las ventas ya sincronizadas con más de N días.
    function limpiarSincronizadas() {
        const limite = Date.now() - DIAS_CONSERVAR_SINCRONIZADAS * 86400000;
        return tx('ventas', 'readwrite', (t) => {
            const s = t.objectStore('ventas');
            const r = s.index('estado').getAll('sincronizada');
            r.onsuccess = () => r.result.forEach((v) => {
                if (v.fecha_sync && new Date(v.fecha_sync).getTime() < limite) s.delete(v.uuid);
            });
        });
    }

    async function sincronizarVentas() {
        if (!navigator.onLine) return { ok: false, motivo: 'offline' };
        if (_sincronizando) return { ok: false, motivo: 'en_curso' };
        _sincronizando = true;
        const res = { ok: true, enviadas: 0, sincronizadas: 0, rechazadas: 0, errores: 0, incidencias: 0 };
        try {
            const pendientes = (await listarVentas('pendiente'))
                .sort((a, b) => (a.fecha_iso < b.fecha_iso ? -1 : 1));
            for (let i = 0; i < pendientes.length; i += TAM_LOTE) {
                const lote = pendientes.slice(i, i + TAM_LOTE);
                const resp = await fetch(URL_SYNC, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': leerCookie('csrftoken') },
                    body: JSON.stringify({ ventas: lote })
                });
                if (resp.status === 401) { Object.assign(res, { ok: false, motivo: 'no_autenticado' }); break; }
                if (resp.status === 403) { Object.assign(res, { ok: false, motivo: 'csrf' }); break; }
                if (!resp.ok) {
                    let detalle = '';
                    try { detalle = (await resp.json()).detalle || ''; } catch (e) { /* respuesta no JSON */ }
                    Object.assign(res, { ok: false, motivo: 'http_' + resp.status, detalle });
                    break;
                }

                const data = await resp.json();
                await aplicarResultados(data.resultados);
                res.enviadas += lote.length;
                data.resultados.forEach((r) => {
                    if (r.estado === 'sincronizada') { res.sincronizadas++; res.incidencias += (r.incidencias || 0); }
                    else if (r.estado === 'rechazada') res.rechazadas++;
                    else res.errores++;
                });
            }
            if (res.ok) await limpiarSincronizadas();
        } catch (e) {
            console.warn('[Offline] Falló la sincronización de ventas:', e);
            Object.assign(res, { ok: false, motivo: 'red' });
        } finally {
            _sincronizando = false;
        }
        if (res.enviadas) console.log('[Offline] Ventas enviadas:', res);
        return res;
    }

    // Envía las ventas y luego refresca el catálogo para que el stock local
    // vuelva a ser el real del servidor.
    async function sincronizarTodo() {
        const rv = await sincronizarVentas();
        if (rv.motivo !== 'offline') await sincronizarCatalogo(rv.sincronizadas > 0);
        window.dispatchEvent(new CustomEvent('mitiendita:sync', { detail: rv }));
        return rv;
    }

    // ---------- Disparadores automáticos ----------
    document.addEventListener('DOMContentLoaded', () => {
        if (navigator.onLine) sincronizarTodo();
    });

    window.addEventListener('online', () => sincronizarTodo());

    // El evento 'online' a veces no llega (wifi inestable): reintento cada minuto.
    setInterval(async () => {
        if (navigator.onLine && (await contarPendientes()) > 0) sincronizarTodo();
    }, 60000);

    // Si se va el internet estando en la pantalla de facturación normal
    // (que depende del servidor), pasamos a la versión offline.
    window.addEventListener('offline', () => {
        if (location.pathname === URL_FACTURACION) {
            location.replace(URL_FACTURACION_OFFLINE);
        }
    });

    global.MiTienditaOffline = {
        version: 'fase3-v2',
        aCentavos, formatoMoneda, nuevoUUID,
        getMeta, setMeta,
        obtenerProductos, sincronizarCatalogo,
        registrarVenta, listarVentas, contarPendientes,
        sincronizarVentas, sincronizarTodo
    };
})(window);
