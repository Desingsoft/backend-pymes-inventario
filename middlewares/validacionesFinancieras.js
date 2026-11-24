/** Contratos de escritura: lista blanca para impedir campos de control inyectados. */
// Importa los validadores de Express para inspeccionar el cuerpo de la petición.
const { body, param } = require('express-validator');
// Reutiliza la función que agrega la validación final del middleware común de solicitudes.
const { aplicar } = require('./validacionesComerciales');

// Crea un validador que solo permite una lista blanca de campos en el JSON recibido.
const permitir = (...campos) => body().custom(valor => {
  // Requiere un objeto JSON real y no un arreglo o valor primitivo.
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error('Se requiere un objeto JSON');
  // Detecta campos no autorizados y devuelve una lista de los que están fuera de la permitida.
  const extras = Object.keys(valor).filter(k => !campos.includes(k));
  // Si existen campos extras, devuelve un error para evitar inyección de atributos de control.
  if (extras.length) throw new Error(`Campos no permitidos: ${extras.join(', ')}`);
  // Si todo está bien, la validación pasa.
  return true;
});
// Genera una validación de ObjectId para un campo específico del cuerpo.
const id = campo => body(campo).isMongoId().withMessage(`${campo} debe ser un identificador válido`);
// Valida que el monto sea positivo y acotado para impedir valores absurdos o de control.
const importe = body('monto').isFloat({ gt: 0, max: 1e12 }).withMessage('monto debe ser positivo');
// Valida una operación de pago con los campos permitidos y reglas adicionales.
const pago = (campo) => aplicar(
  // Solo acepta los campos esperados para una operación financiera de pago.
  permitir(campo, 'monto', 'metodo', 'fecha', 'referencia', 'nota'), id(campo), importe,
  // El método de pago debe ser texto y de tamaño razonable.
  body('metodo').optional().isString().isLength({ min: 1, max: 40 }),
  // La referencia es opcional, pero si existe debe ser texto corto.
  body('referencia').optional().isString().isLength({ max: 160 }),
  // La nota es opcional, pero no puede exceder el límite establecido.
  body('nota').optional().isString().isLength({ max: 1000 })
);
// Valida una solicitud de devolución con sus items, motivo y estructura de producto devuelto.
const devolucion = aplicar(
  // Solo se permiten los campos conocidos del flujo de devolución y reembolso.
  permitir('pedidoId', 'motivo', 'nota', 'items', 'reembolso'), id('pedidoId'),
  // El motivo de la devolución debe ser un texto con longitud mínima y máxima razonable.
  body('motivo').isString().trim().isLength({ min: 3, max: 500 }),
  // La nota del detalle es opcional y limitada.
  body('nota').optional().isString().isLength({ max: 1000 }),
  // Los ítems deben venir como un arreglo con tamaño fijo dentro de límites.
  body('items').isArray({ min: 1, max: 200 }),
  // Cada elemento del array debe ser un objeto válido.
  body('items.*').isObject(),
  // La cantidad por producto debe ser un entero positivo dentro del límite.
  body('items.*.cantidad').isInt({ min: 1, max: 1000000 }),
  // Asegura que cada item solo tenga campos permitidos para la devolución.
  body('items.*').custom(item => {
    const permitidos = ['producto', 'cantidad', 'estado', 'bodega', 'motivo'];
    if (Object.keys(item).some(k => !permitidos.includes(k))) throw new Error('Campo no permitido en producto devuelto');
    return true;
  })
);
// Valida la creación de un documento financiero como factura o remisión.
const documento = aplicar(
  // Solo acepta la estructura del documento fiscal para evitar campos sueltos.
  permitir('pedidoId', 'tipo', 'formaPago', 'diasCredito', 'notas', 'ivaPorcentaje', 'metodoPago', 'referenciaPago', 'forzarCupo'),
  id('pedidoId'), body('tipo').isIn(['factura', 'remision']),
  // La forma de pago puede ser contado o crédito.
  body('formaPago').optional().isIn(['contado', 'credito']),
  // Los días de crédito deben estar en un rango realista.
  body('diasCredito').optional().isInt({ min: 0, max: 3650 }),
  // El IVA solo puede estar en rango de 0 a 100.
  body('ivaPorcentaje').optional().isFloat({ min: 0, max: 100 }),
  // La bandera de cupo forzado es opcional y debe ser booleana.
  body('forzarCupo').optional().isBoolean(),
  // Las notas del documento son opcionales y con longitud acotada.
  body('notas').optional().isString().isLength({ max: 2000 })
);
// Valida la anulación de un documento o pago, exigiendo un motivo con longitud suficiente.
const anulacion = aplicar(permitir('motivo'), body('motivo').isString().trim().isLength({ min: 3, max: 1000 }));
// Exporta las validaciones reutilizables del módulo financiero.
module.exports = { pago, devolucion, documento, anulacion };
