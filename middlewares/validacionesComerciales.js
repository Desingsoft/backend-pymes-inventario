/**
 * Validaciones transversales de rutas comerciales con express-validator.
 * Se validan identificadores y estructuras de solicitudes sin convertir importes
 * automáticamente: los controladores siguen siendo responsables de las reglas
 * contables, concurrencia y límites transaccionales.
 */
// Importa los validadores de Express para inspeccionar body, params y headers.
const { body, param, header } = require('express-validator');
// Importa el middleware que ejecuta la validación final y devuelve errores en formato estándar.
const validar = require('./validarSolicitud');

/** Comprueba que el cuerpo JSON sea un objeto y limita la cantidad de campos. */
// Valida que el payload recibido sea un objeto JSON válido y no un arreglo.
const objeto = body().custom(valor => {
  // Si el valor no existe, no es un objeto o es un arreglo, falla la validación.
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error('Se requiere un objeto JSON');
  // Limita la cantidad de propiedades para evitar payloads excesivamente grandes o maliciosos.
  if (Object.keys(valor).length > 60) throw new Error('Demasiados campos');
  // Si todo está bien, la validación pasa.
  return true;
});
// Valida que el parámetro recibido en la URL sea un ObjectId de MongoDB válido.
const identificador = campo => param(campo).isMongoId().withMessage(`Identificador ${campo} inválido`);
// Valida un monto opcional, asegurando que sea un número positivo y no exceda un límite razonable.
const monto = campo => body(campo).optional().isFloat({ min: 0, max: 1e12 }).withMessage(`${campo} debe ser un importe no negativo`);
// Valida un porcentaje opcional entre 0 y 100, usado por impuestos o comisiones.
const porcentaje = campo => body(campo).optional().isFloat({ min: 0, max: 100 }).withMessage(`${campo} debe estar entre 0 y 100`);
// Valida que el campo items, si viene, sea un arreglo con elementos dentro de un rango permitido.
const items = body('items').optional().isArray({ min: 1, max: 200 }).withMessage('Se requiere una lista válida de productos');
// Valida la cabecera Idempotency-Key en las operaciones de escritura para evitar reintentos duplicados.
const claveIdempotencia = header('Idempotency-Key').exists().withMessage('Falta Idempotency-Key').bail()
  // Asegura que la clave sea texto con longitud mínima y máxima permitidas.
  .isString().isLength({ min: 8, max: 128 }).matches(/^[a-zA-Z0-9._:-]+$/)
  // Muestra un error si la clave tiene formato inválido.
  .withMessage('Clave de idempotencia inválida');

/** Aplica reglas a rutas específicas; no reemplaza el middleware de permisos. */
// Junta todas las validaciones concretas con el middleware final que devuelve errores estandarizados.
const aplicar = (...reglas) => [...reglas, validar];
// Exporta las validaciones para reutilizarse en rutas del negocio.
module.exports = { objeto, identificador, monto, porcentaje, items, claveIdempotencia, aplicar };
