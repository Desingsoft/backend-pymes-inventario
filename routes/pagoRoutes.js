// Importa el middleware que restringe el acceso y la lógica según la sucursal activa.
const sede = require('../middlewares/alcanceSucursal');
// Importa el middleware que valida y ajusta la operación según la sucursal de origen y destino.
const sedeOperacion = require('../middlewares/sucursalOperaciones');
// Importa las validaciones reutilizables para entidades comerciales: objeto, identificador, monto, porcentaje, items, idempotencia y aplicador.
const { objeto, identificador, monto, porcentaje, items, claveIdempotencia, aplicar } = require('../middlewares/validacionesComerciales');
/**
 * Archivo: pagoRoutes.js
 * Propósito: Enrutador Express: define endpoints, autenticación y autorización.
 * Mantenimiento: documentar validaciones, efectos secundarios y errores al modificar funciones.
 */
// Importa el middleware que verifica permisos granulares por operación financiera.
const permiso = require('../middlewares/permiso'); // Control granular por operación.
// Importa Express para crear el router de las rutas HTTP.
const express = require('express');
// Crea una instancia del router de Express para registrar rutas del módulo de pagos.
const router = express.Router();
// Importa el controlador que ejecuta la lógica de negocio de pagos.
const controller = require('../controllers/pagoController');
// Importa el middleware que valida y decodifica el token JWT en cada petición.
const verifyToken = require('../middlewares/verifyToken');
// Importa las reglas de negocio para validar transacciones financieras.
const reglasFinancieras = require('../middlewares/validacionesFinancieras');
// Importa el middleware que comprueba el rol del usuario antes de permitir la ruta.
const checkRole = require('../middlewares/checkRole');
// Importa la autorización específica para documentos financieros y pagos.
const titular = require('../middlewares/autorizacionFinanciera');

// Aplica la verificación del token JWT a todas las rutas definidas en este enrutador.
router.use(verifyToken);

// Cobros a clientes: admin y ventas. Pagos a proveedores: solo admin (el controlador lo exige en las consultas).
// Obtiene la lista de pagos registrados y exige permisos de lectura y rol de admin/ventas.
router.get('/', checkRole(['admin', 'ventas']), permiso('pagos.leer'), sede.cargar, controller.listar);
// Registra un cobro de cliente validando el objeto, la idempotencia, reglas financieras y la autorización del documento financiero.
router.post('/cobro', checkRole(['admin', 'ventas']), permiso('pagos.crear'), ...aplicar(objeto, claveIdempotencia), ...reglasFinancieras.pago('documentoId'), titular.permitirDocumentoFinanciero, ...sedeOperacion.porDocumento('documentoId'), controller.registrarCobro);
// Registra un reembolso para un cliente, con la misma validación y control de negocio que los cobros.
router.post('/reembolso', checkRole(['admin', 'ventas']), permiso('pagos.crear'), ...aplicar(objeto, claveIdempotencia), ...reglasFinancieras.pago('documentoId'), titular.permitirDocumentoFinanciero, ...sedeOperacion.porDocumento('documentoId'), controller.registrarReembolso);
// Registra un egreso o pago a proveedores, permitiendo solo a administradores y validando la orden asociada.
router.post('/egreso', checkRole(['admin']), permiso('pagos.crear'), ...aplicar(objeto, claveIdempotencia), ...reglasFinancieras.pago('ordenId'), controller.registrarEgreso);
// Busca pagos por documento financiero y exige rol de admin/ventas y autorización específica sobre el documento.
router.get('/documento/:id', checkRole(['admin', 'ventas']), permiso('pagos.leer'), ...aplicar(identificador('id')), titular.permitirDocumentoFinanciero, ...sedeOperacion.porDocumento('id', 'params'), controller.porDocumento); // antes que /:id
// Obtiene pagos asociados a una orden, solo permitido para administradores.
router.get('/orden/:id', checkRole(['admin']), permiso('pagos.leer'), ...aplicar(identificador('id')), controller.porOrden);
// Trae un pago específico por su id, validando el identificador, autenticación y permisos del pago.
router.get('/:id', checkRole(['admin', 'ventas']), permiso('pagos.leer'), ...aplicar(identificador('id')), titular.permitirPago, sede.cargar, controller.obtener);
// Anula un pago por id, validando la identidad, el objeto y las reglas de anulación financiera.
router.patch('/:id/anular', checkRole(['admin']), permiso('pagos.editar'), ...aplicar(identificador('id'), objeto), ...reglasFinancieras.anulacion, controller.anular);

// Exporta el router para que Express lo registre en la aplicación principal.
module.exports = router;
