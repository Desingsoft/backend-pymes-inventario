// Importa el middleware que restringe las consultas de pedidos según la sucursal autorizada del usuario.
const sede = require('../middlewares/alcanceSucursal');
// Importa el middleware que valida la operación según la sucursal de origen o destino durante la manipulación del pedido.
const sedeOperacion = require('../middlewares/sucursalOperaciones');
// Importa la autorización de registros para verificar si el usuario tiene acceso al pedido solicitado.
const titularidad = require('../middlewares/autorizacionRegistro');
// Importa las validaciones reutilizables para requests comerciales: cuerpo JSON, id, monto, porcentaje, items y aplicador.
const { objeto, identificador, monto, porcentaje, items, claveIdempotencia, aplicar } = require('../middlewares/validacionesComerciales');
/**
 * Archivo: pedidoRoutes.js
 * Propósito: Enrutador Express: define endpoints, autenticación y autorización.
 * Mantenimiento: documentar validaciones, efectos secundarios y errores al modificar funciones.
 */
// Importa Express para crear el router de rutas del módulo de pedidos.
const express = require('express');
// Crea el router que registra las rutas HTTP del módulo.
const router = express.Router();
// Importa el controlador de pedidos que ejecuta la lógica de negocio.
const pedidoController = require('../controllers/pedidoController');
// Importa el middleware que valida y decodifica el JWT del usuario en cada request.
const verifyToken = require('../middlewares/verifyToken');
// Importa el middleware que valida roles permitidos para la ruta.
const checkRole = require('../middlewares/checkRole');
// Importa el middleware que valida los permisos granulares por operación.
const permiso = require('../middlewares/permiso');

// GET /api/pedidos - lista todos los pedidos visibles para el usuario autenticado en la sucursal correspondiente.
router.get('/', verifyToken, permiso('pedidos.leer'), sede.cargar, pedidoController.obtenerTodos);
// GET /api/pedidos/resumen - devuelve un resumen global de pedidos según el alcance de la sucursal.
router.get('/resumen', verifyToken, permiso('pedidos.leer'), sede.cargar, pedidoController.obtenerResumen);
// GET /api/pedidos/:id - obtiene un pedido específico, validando su id, permisos y alcance por sucursal.
router.get('/:id', verifyToken, permiso('pedidos.leer'), ...aplicar(identificador('id')), titularidad.permitirPedido(), sede.cargar, sede.pedido(), pedidoController.obtenerPorId);
// POST /api/pedidos - crea un nuevo pedido validando su estructura y la bodega asociada.
router.post('/', verifyToken, checkRole(['admin', 'ventas']), permiso('pedidos.crear'), ...aplicar(objeto, items, porcentaje('descuentoPorcentaje')), ...sedeOperacion.porBodega('bodegaId'), pedidoController.crear);
// PATCH /api/pedidos/:id/estado - cambia el estado de un pedido validando permisos y autorización del registro asociado.
router.patch('/:id/estado', verifyToken, checkRole(['admin', 'ventas', 'bodeguero']), permiso('pedidos.editar'), ...aplicar(identificador('id'), objeto), titularidad.permitirPedido(), ...sedeOperacion.porPedido('id', 'params'), pedidoController.cambiarEstado);

// Exporta el router para registrarlo en la aplicación principal de Express.
module.exports = router;
