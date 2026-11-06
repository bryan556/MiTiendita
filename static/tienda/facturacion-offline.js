/* ==========================================================
   MiTiendita - Pantalla de facturación SIN conexión (Fase 2)
   Carrito en memoria + catálogo y ventas en IndexedDB.
   Solo ventas al contado a "Público General" (cliente 1).
   ========================================================== */
(function () {
    'use strict';
    const DB = window.MiTienditaOffline;
    const $ = (id) => document.getElementById(id);

    if (!DB || typeof DB.sincronizarTodo !== 'function') {
        console.error('[Offline] offline-db.js no se cargó, o es una versión vieja (sin sincronización).');
        document.addEventListener('DOMContentLoaded', () => {
            const a = $('aviso-catalogo');
            if (a) { a.classList.remove('d-none'); a.textContent = 'Archivos desactualizados o incompletos (offline-db.js). Recarga con Ctrl+Shift+R; si persiste, DevTools → Application → Clear site data.'; }
        });
        return;
    }

    let productos = [];
    const carrito = new Map();       // id -> {id, nombre, precio_cent, cantidad}
    let cajaAbierta = false;

    function esc(t) {
        return String(t).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    const totalItems = () => [...carrito.values()].reduce((a, i) => a + i.cantidad, 0);
    const subtotalCarrito = () => [...carrito.values()].reduce((a, i) => a + i.precio_cent * i.cantidad, 0);
    const envioCent = () => Math.max(0, DB.aCentavos($('input-envio').value || '0'));
    const totalCent = () => subtotalCarrito() + envioCent();
    const stockLocal = (id) => { const p = productos.find((x) => x.id === id); return p ? p.stock : 0; };

    function mostrarError(msg) {
        const e = $('mensaje-error');
        e.textContent = msg || '';
        e.classList.toggle('d-none', !msg);
    }

    // ---------- Render ----------
    function renderProductos() {
        const q = $('buscador').value.trim().toLowerCase();
        const lista = productos.filter((p) =>
            !q || p.nombre.toLowerCase().includes(q) || (p.codigo_barra && p.codigo_barra.toLowerCase().includes(q)));

        $('grid-productos').innerHTML = lista.length ? lista.map((p) => `
            <div class="col">
                <div class="card h-100 prod-offline rounded-3 overflow-hidden ${p.stock <= 0 ? 'sin-stock' : ''}" data-id="${p.id}">
                    <span class="badge ${p.stock <= 0 ? 'bg-danger' : 'bg-secondary'} position-absolute top-0 end-0 m-1">Stock: ${Math.max(0, p.stock)}</span>
                    <div class="text-center p-3" style="font-size: 2.2rem;">📦</div>
                    <div class="card-body p-2 text-center border-top">
                        <h6 class="card-title text-truncate fw-bold mb-1" style="font-size: .9rem;">${esc(p.nombre)}</h6>
                        <h5 class="text-success fw-bold mb-0">${DB.formatoMoneda(p.precio_cent)}</h5>
                    </div>
                </div>
            </div>`).join('')
            : '<div class="col-12 text-center py-5 text-muted">No se encontraron productos.</div>';
    }

    function renderCarrito() {
        const filas = [...carrito.values()].map((i) => {
            const falta = i.cantidad > stockLocal(i.id);
            return `
            <tr>
                <td class="ps-3 py-2">
                    <div class="fw-bold text-truncate" style="max-width: 170px;">${esc(i.nombre)}</div>
                    ${falta ? '<div class="text-warning small fw-bold"><i class="fas fa-triangle-exclamation"></i> Stock local insuficiente</div>' : ''}
                    <a href="#" class="text-danger text-decoration-none small fw-bold" data-accion="quitar" data-id="${i.id}">
                        <i class="fas fa-times"></i> Quitar</a>
                </td>
                <td class="text-center py-2">
                    <div class="btn-group btn-group-sm border border-secondary rounded">
                        <button type="button" class="btn btn-outline-secondary px-2 fw-bold border-0" data-accion="restar" data-id="${i.id}">-</button>
                        <span class="btn disabled fw-bold px-2 border-0 bg-transparent" style="opacity:1;color:inherit;">${i.cantidad}</span>
                        <button type="button" class="btn btn-outline-secondary px-2 fw-bold border-0" data-accion="sumar" data-id="${i.id}">+</button>
                    </div>
                </td>
                <td class="text-end pe-3 fw-bold text-success">${DB.formatoMoneda(i.precio_cent * i.cantidad)}</td>
            </tr>`;
        });
        $('cuerpo-carrito').innerHTML = filas.length ? filas.join('') :
            '<tr><td colspan="3" class="text-center py-5 text-muted opacity-50"><i class="fas fa-shopping-basket fs-1 mb-2"></i><br>Carrito vacío</td></tr>';
        $('contador-items').textContent = totalItems() + ' Ítems';
        recalcular();
    }

    function recalcular() {
        const total = totalCent();
        $('display-total').textContent = DB.formatoMoneda(total);

        const pago = DB.aCentavos($('input-pago').value || '0');
        const dif = pago - total;
        const lbl = $('label-cambio');
        const disp = $('display-cambio');
        if (carrito.size && dif < 0) {
            lbl.textContent = 'FALTAN:';
            disp.textContent = DB.formatoMoneda(-dif);
            disp.className = 'h4 m-0 fw-bold text-danger';
        } else {
            lbl.textContent = 'CAMBIO:';
            disp.textContent = DB.formatoMoneda(Math.max(0, dif));
            disp.className = 'h4 m-0 fw-bold text-success';
        }
        $('btn-cobrar').disabled = !(carrito.size && cajaAbierta && pago >= total && total > 0);
    }

    async function actualizarPendientes() {
        const n = await DB.contarPendientes();
        $('contador-pendientes').textContent = n + (n === 1 ? ' pendiente' : ' pendientes');
    }

    // ---------- Carrito ----------
    function agregar(id) {
        const p = productos.find((x) => x.id === id);
        if (!p) return;
        const ya = carrito.get(id);
        if (ya) ya.cantidad += 1;
        else carrito.set(id, { id: p.id, nombre: p.nombre, precio_cent: p.precio_cent, cantidad: 1 });
        mostrarError('');
        renderCarrito();
    }

    function cambiarCantidad(id, delta) {
        const it = carrito.get(id);
        if (!it) return;
        it.cantidad += delta;
        if (it.cantidad <= 0) carrito.delete(id);
        renderCarrito();
    }

    function vaciar() {
        carrito.clear();
        $('input-envio').value = '';
        $('input-pago').value = '';
        mostrarError('');
        renderCarrito();
    }

    // ---------- Cobro ----------
    async function cobrar() {
        mostrarError('');
        if (!carrito.size) return;
        if (!cajaAbierta) return mostrarError('La caja está cerrada. Ábrela estando en línea.');

        const total = totalCent();
        const pago = DB.aCentavos($('input-pago').value || '0');
        if (pago < total) return mostrarError('El pago es menor al total.');

        const sinStock = [...carrito.values()].filter((i) => i.cantidad > stockLocal(i.id));
        if (sinStock.length) {
            const detalle = sinStock.map((i) => `• ${i.nombre} (vendes ${i.cantidad}, stock local ${Math.max(0, stockLocal(i.id))})`).join('\n');
            if (!confirm('Según el último inventario descargado, no alcanza el stock de:\n\n' + detalle +
                '\n\nLa venta se registrará igual y el administrador revisará el inventario al sincronizar. ¿Continuar?')) return;
        }

        const usuario = (await DB.getMeta('usuario')) || {};
        const items = [...carrito.values()].map((i) => ({
            id: i.id, nombre: i.nombre, precio_cent: i.precio_cent,
            cantidad: i.cantidad, subtotal_cent: i.precio_cent * i.cantidad
        }));

        const venta = {
            uuid: DB.nuevoUUID(),
            numero_provisional: null,                 // lo asigna registrarVenta
            fecha_iso: new Date().toISOString(),      // hora REAL de la venta
            usuario_id: usuario.id || null,
            usuario_nombre: usuario.nombre || '',
            cliente_id: 1,                            // Público General
            tipo_pago: 'contado',
            items,
            costo_envio_cent: envioCent(),
            total_cent: total,
            pago_cent: pago,
            cambio_cent: pago - total,
            estado: 'pendiente'
        };

        try {
            const guardada = await DB.registrarVenta(venta);
            mostrarTicket(guardada);
            vaciar();
            productos = await DB.obtenerProductos();
            renderProductos();
            actualizarPendientes();
            renderVentas();
        } catch (e) {
            console.error(e);
            mostrarError('No se pudo guardar la venta en este equipo: ' + (e && e.message ? e.message : e));
        }
    }

    // ---------- Ticket provisional ----------
    function htmlTicket(v) {
        const fecha = new Date(v.fecha_iso).toLocaleString('es-NI');
        const filas = v.items.map((i) => `
            <tr><td>${esc(i.nombre)}<br><small>${i.cantidad} x ${DB.formatoMoneda(i.precio_cent)}</small></td>
            <td style="text-align:right;vertical-align:bottom;">${DB.formatoMoneda(i.subtotal_cent)}</td></tr>`).join('');
        return `
            <div style="font-family: monospace;">
                <div class="text-center fw-bold">MI TIENDITA</div>
                <div class="text-center small">TICKET PROVISIONAL ${esc(v.numero_provisional)}</div>
                <div class="text-center small mb-2">${esc(fecha)}${v.usuario_nombre ? ' · ' + esc(v.usuario_nombre) : ''}</div>
                <table style="width:100%;font-size:.9rem;">${filas}</table>
                <hr>
                ${v.costo_envio_cent ? `<div class="d-flex justify-content-between"><span>Envío</span><span>${DB.formatoMoneda(v.costo_envio_cent)}</span></div>` : ''}
                <div class="d-flex justify-content-between fw-bold"><span>TOTAL</span><span>${DB.formatoMoneda(v.total_cent)}</span></div>
                <div class="d-flex justify-content-between"><span>Pago</span><span>${DB.formatoMoneda(v.pago_cent)}</span></div>
                <div class="d-flex justify-content-between"><span>Cambio</span><span>${DB.formatoMoneda(v.cambio_cent)}</span></div>
                <hr>
                <div class="text-center small">Venta registrada sin conexión. El número de factura definitivo se asigna al sincronizar.</div>
            </div>`;
    }

    function mostrarTicket(v) {
        $('ticket-contenido').innerHTML = htmlTicket(v);
        bootstrap.Modal.getOrCreateInstance($('modalTicket')).show();
    }

    function imprimir() {
        const w = window.open('', '_blank', 'width=380,height=600');
        if (!w) return;
        w.document.write('<html><head><title>Ticket</title></head><body style="font-family:monospace;width:300px">' +
            $('ticket-contenido').innerHTML + '</body></html>');
        w.document.close();
        w.focus();
        w.print();
    }

    // ---------- Eventos ----------
    function enlazar() {
        $('grid-productos').addEventListener('click', (e) => {
            const card = e.target.closest('[data-id]');
            if (card) agregar(Number(card.dataset.id));
        });

        $('cuerpo-carrito').addEventListener('click', (e) => {
            const el = e.target.closest('[data-accion]');
            if (!el) return;
            e.preventDefault();
            const id = Number(el.dataset.id);
            if (el.dataset.accion === 'sumar') cambiarCantidad(id, 1);
            else if (el.dataset.accion === 'restar') cambiarCantidad(id, -1);
            else if (el.dataset.accion === 'quitar') { carrito.delete(id); renderCarrito(); }
        });

        $('buscador').addEventListener('input', renderProductos);
        $('buscador').addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const codigo = $('buscador').value.trim().toLowerCase();
            const p = productos.find((x) => x.codigo_barra && x.codigo_barra.toLowerCase() === codigo);
            if (p) { agregar(p.id); $('buscador').value = ''; renderProductos(); }
        });

        $('input-envio').addEventListener('input', recalcular);
        $('input-pago').addEventListener('input', recalcular);
        $('btn-cobrar').addEventListener('click', cobrar);
        $('btn-vaciar').addEventListener('click', () => { if (!carrito.size || confirm('¿Vaciar el carrito?')) vaciar(); });
        $('btn-imprimir').addEventListener('click', imprimir);
    }

    // ---------- Estado de red y sincronización ----------
    function actualizarEstadoRed() {
        const en = $('aviso-estado');
        const enLinea = navigator.onLine;
        en.classList.toggle('alert-warning', !enLinea);
        en.classList.toggle('alert-success', enLinea);
        $('texto-estado').innerHTML = enLinea
            ? '<i class="fas fa-wifi me-2"></i><strong>Con conexión.</strong> Las ventas guardadas se envían solas al servidor.'
            : '<i class="fas fa-plug-circle-xmark me-2"></i><strong>Modo sin conexión.</strong> Las ventas se guardan en este equipo y se enviarán al volver el internet.';
        $('btn-sync').disabled = !enLinea;
    }

    function mensajeSync(tipo, texto) {
        const m = $('mensaje-sync');
        m.className = 'alert py-2 mb-3 alert-' + tipo;
        m.textContent = texto;
    }

    function resumenSync(r) {
        if (!r.ok) {
            if (r.motivo === 'offline' || r.motivo === 'en_curso') return null;
            const causas = {
                no_autenticado: 'Tu sesión expiró. Inicia sesión de nuevo para sincronizar; las ventas siguen guardadas aquí.',
                csrf: 'El servidor rechazó la solicitud (seguridad). Recarga la página e intenta de nuevo.',
                red: 'No se pudo contactar con el servidor. Se reintentará automáticamente.'
            };
            return ['danger', causas[r.motivo] || ('El servidor respondió con error (' + r.motivo + ')' + (r.detalle ? ': ' + r.detalle : '') + '. Se reintentará.')];
        }
        if (!r.enviadas) return null;
        let t = `${r.sincronizadas} venta(s) sincronizada(s) con el servidor.`;
        if (r.incidencias) t += ` ${r.incidencias} producto(s) quedaron con stock negativo: el administrador debe revisar el inventario.`;
        if (r.rechazadas) t += ` ${r.rechazadas} venta(s) fueron rechazadas (ver detalle abajo).`;
        if (r.errores) t += ` ${r.errores} venta(s) siguen pendientes por un error temporal.`;
        return [r.rechazadas || r.errores ? 'warning' : 'success', t];
    }

    async function renderVentas() {
        const ventas = (await DB.listarVentas()).sort((a, b) => (a.fecha_iso < b.fecha_iso ? 1 : -1)).slice(0, 15);
        $('cuerpo-ventas').innerHTML = ventas.length ? ventas.map((v) => {
            let estado;
            if (v.estado === 'sincronizada') estado = `<span class="badge bg-success">Sincronizada</span> <small class="text-muted">Factura #${esc(v.id_factura)}</small>`;
            else if (v.estado === 'rechazada') estado = `<span class="badge bg-danger">Rechazada</span> <small class="text-danger">${esc(v.motivo || '')}</small>`;
            else estado = '<span class="badge bg-warning text-dark">Pendiente</span>' + (v.ultimo_error ? ` <small class="text-muted">${esc(v.ultimo_error)}</small>` : '');
            return `<tr><td class="ps-3 fw-bold">${esc(v.numero_provisional || '')}</td>
                <td>${esc(new Date(v.fecha_iso).toLocaleString('es-NI'))}</td>
                <td class="text-end">${DB.formatoMoneda(v.total_cent)}</td><td>${estado}</td></tr>`;
        }).join('') : '<tr><td colspan="4" class="text-center text-muted py-3">Aún no hay ventas guardadas en este equipo.</td></tr>';
    }

    async function refrescarTodo() {
        await cargarDatosLocales();
        await actualizarPendientes();
        await renderVentas();
    }

    async function sincronizarAhora() {
        $('btn-sync').disabled = true;
        mensajeSync('info', 'Sincronizando...');
        const r = await DB.sincronizarTodo();     // dispara también el evento 'mitiendita:sync'
        const res = resumenSync(r);
        if (res) mensajeSync(res[0], res[1]);
        else $('mensaje-sync').classList.add('d-none');
        actualizarEstadoRed();
    }

    // ---------- Catálogo ----------
    const MOTIVOS = {
        offline: 'No hay conexión a internet.',
        no_autenticado: 'La sesión no está iniciada. Inicia sesión estando en línea.',
        red: 'No se pudo contactar con el servidor.'
    };

    function textoMotivo(m) {
        if (MOTIVOS[m]) return MOTIVOS[m];
        if (String(m).startsWith('http_')) return 'El servidor respondió con error (' + String(m).slice(5) + '). Revisa la consola de Django.';
        return 'Error desconocido.';
    }

    async function cargarDatosLocales() {
        try {
            productos = await DB.obtenerProductos();
            cajaAbierta = !!(await DB.getMeta('caja_abierta'));
        } catch (e) {
            console.error('IndexedDB no disponible', e);
            productos = [];
        }
        $('aviso-catalogo').classList.toggle('d-none', productos.length > 0);
        $('aviso-caja').classList.toggle('d-none', !productos.length || cajaAbierta);
        renderProductos();
        renderCarrito();
    }

    async function descargarCatalogo() {
        const estado = $('estado-descarga');
        estado.textContent = 'Descargando...';
        const r = await DB.sincronizarCatalogo(true);
        await cargarDatosLocales();
        if (r.ok) {
            estado.textContent = '';
        } else {
            $('aviso-catalogo').classList.remove('d-none');
            estado.textContent = textoMotivo(r.motivo);
        }
    }

    // ---------- Inicio ----------
    async function iniciar() {
        enlazar();
        $('btn-descargar').addEventListener('click', descargarCatalogo);
        $('btn-sync').addEventListener('click', sincronizarAhora);
        window.addEventListener('online', actualizarEstadoRed);
        window.addEventListener('offline', actualizarEstadoRed);
        // Sincronización automática (la dispara offline-db.js): refrescamos pantalla y mostramos el resultado
        window.addEventListener('mitiendita:sync', async (e) => {
            await refrescarTodo();
            const res = e.detail ? resumenSync(e.detail) : null;
            if (res) mensajeSync(res[0], res[1]);
        });
        actualizarEstadoRed();
        $('version-offline').textContent = 'Módulo offline ' + DB.version;
        await cargarDatosLocales();
        actualizarPendientes();
        renderVentas();
        // Si hay internet y todavía no hay catálogo, lo descargamos aquí mismo.
        if (!productos.length && navigator.onLine) descargarCatalogo();
    }

    document.addEventListener('DOMContentLoaded', iniciar);
})();
