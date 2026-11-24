// Importa la lógica de alcance por sucursal para restringir consultas a la sede autorizada.
const alcanceSede = require('../middlewares/alcanceSucursal');
/**
 * Archivo: pagoController.js
 * Propósito: Controlador HTTP: recibe solicitudes, valida reglas y coordina operaciones de negocio.
 * Mantenimiento: documentar validaciones, efectos secundarios y errores al modificar funciones.
 */
// Importa Mongoose para validar ObjectIds y trabajar con modelos MongoDB.
const mongoose = require('mongoose');
// Importa la utilidad que calcula una huella física de la solicitud para idempotencia.
const { huellaOperacion } = require('../utils/huellaOperacion');
// Importa el modelo de movimientos de pago almacenados en la base de datos.
const Pago = require('../models/Pago');
// Importa el modelo de documentos financieros vinculados a facturas, notas y remisiones.
const Documento = require('../models/Documento');
// Importa la utilidad para saber si el usuario pertenece a la zona de ventas.
const { esVentas } = require('../middlewares/autorizacionRegistro');
// Importa la función para recuperar documentos propios del usuario.
const { documentosPropios } = require('../middlewares/autorizacionFinanciera');
// Importa el modelo de órdenes de compra que se pagan a proveedores.
const OrdenCompra = require('../models/OrdenCompra');
// Importa la utilidad para ejecutar lógica dentro de una transacción MongoDB.
const { conTransaccion } = require('../utils/transaccion');
// Importa helpers para obtener el número consecutivo y formatearlo en recibos/documentos.
const { siguiente, formatear } = require('../utils/consecutivos');
// Importa la utilidad para construir rangos de fechas a partir de query params.
const { rangoDesdeQuery } = require('../utils/fechas');
// Importa funciones de cartera para calcular saldos y estados financieros de documentos/órdenes.
const { estadoPagoDe, saldoDeFactura, saldoAFavorDe, saldoDeOrden } = require('../utils/cartera');
// Importa el controlador de configuración para leer prefijos del sistema.
const { cargar: cargarConfig } = require('./configuracionController');

/**
 * Lee una clave de idempotencia suministrada por el cliente (UUID recomendado).
 * Es obligatoria en operaciones nuevas: evita reintentos ambiguos tras una caída de red.
 * La restricción única en MongoDB garantiza que dos solicitudes con la misma clave
 * no creen dos pagos, incluso cuando se ejecutan simultáneamente.
 */
// Valida la cabecera de idempotencia y devuelve la clave si es válida.
const claveDePago = (req) => {
  // Lee la cabecera exacta usada por el cliente para evitar duplicados de la misma operación.
  const clave = req.get('Idempotency-Key');
  // Exige que la clave exista y cumpla un patrón seguro (16 a 128 caracteres alfanuméricos, guion o guion bajo).
  if (typeof clave !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(clave)) {
    throw { status: 400, mensaje: 'Se requiere Idempotency-Key (16 a 128 caracteres alfanuméricos, guion o guion bajo)' };
  }
  // Devuelve la clave válida para usarla en la operación.
  return clave;
};

// Define los métodos de pago permitidos por la lógica financiera del sistema.
const METODOS = ['efectivo', 'transferencia', 'tarjeta', 'cheque', 'otro'];
// Límite máximo de filas devueltas en listados para proteger el rendimiento.
const LIMITE_FILAS = 1000;
// Comprueba si un identificador de MongoDB es válido.
const idValido = (id) => mongoose.isValidObjectId(id);
// Crea un objeto de error estándar con http status y mensaje legible.
const falla = (status, mensaje) => ({ status, mensaje });
// Centraliza la respuesta de error, diferenciando error de negocio y errores internos.
const responderError = (res, error, mensaje) =>
  error.status ? res.status(error.status).json({ mensaje: error.mensaje }) : res.status(500).json({ mensaje });
// Formatea un número a moneda colombiana para mostrarlo al usuario.
const pesos = (n) => `$${Math.round(n).toLocaleString('es-CO')}`;
// Envuelve la sesión de MongoDB en un objeto con clave session para pasarla a funciones de Mongoose.
const sesion = (s) => ({ session: s || undefined });

// --- Recalcular lo pagado desde los pagos vigentes (única fuente de verdad) ---
// Suma los montos de los pagos vigentes para un filtro determinado.
const sumaVigentes = async (filtro, session) => {
  // Lee los pagos vigentes del filtro solicitado y proyecta solo el campo monto.
  const pagos = await Pago.find({ ...filtro, estado: 'vigente' }).session(session || null).select('monto').lean();
  // Acumula el total y devuelve el valor final.
  return pagos.reduce((s, p) => s + p.monto, 0);
};

// Recalcula el estado financiero de una factura al cambiar pagos o reembolsos.
const recalcularFactura = async (documentoId, session) => {
  // Busca la factura por id para actualizar su estado de cartera.
  const doc = await Documento.findById(documentoId).session(session || null);
  // Si no existe la factura, no hace nada.
  if (!doc) return null;
  // El importe pagado equivale a todos los cobros vigentes de la factura.
  doc.pagado = await sumaVigentes({ documento: documentoId, tipo: 'cobro' }, session);
  // El importe reembolsado equivale a todas las devoluciones vigentes del cliente.
  doc.reembolsado = await sumaVigentes({ documento: documentoId, tipo: 'reembolso' }, session);
  // Las notas crédito vigentes de la factura reducen lo que se debe.
  const notas = await Documento.find({ facturaOrigen: documentoId, tipo: 'nota_credito', estado: 'emitida' }).session(session || null).select('total').lean();
  // Acumula el total acreditado por notas crédito.
  doc.acreditado = notas.reduce((s, n) => s + n.total, 0);
  // Calcula el estado general del pago usando la lógica de cartera corporativa.
  doc.estadoPago = estadoPagoDe(doc.total, doc.pagado, doc.acreditado, doc.reembolsado);
  // Guarda los cambios en la factura.
  await doc.save(sesion(session));
  // Devuelve el documento actualizado.
  return doc;
};

// Recalcula el monto pagado acumulado de una orden de compra.
const recalcularOrden = async (ordenId, session) => {
  // Busca la orden por id.
  const orden = await OrdenCompra.findById(ordenId).session(session || null);
  // Si no existe, retorna nulo.
  if (!orden) return null;
  // El monto pagado en la orden es la suma de todos los egresos vigentes asociados.
  orden.pagado = await sumaVigentes({ orden: ordenId }, session);
  // Guarda la orden actualizada.
  await orden.save(sesion(session));
  // Devuelve la orden actualizada.
  return orden;
};

// Valida los datos comunes de un pago. Devuelve { monto, metodo, fecha, referencia, nota }.
const leerDatos = (cuerpo) => {
  // Convierte el monto a número para asegurar validación numérica.
  const monto = Number(cuerpo.monto);
  // Exige que el monto sea entero y positivo.
  if (!Number.isInteger(monto) || monto < 1) throw falla(400, 'El monto debe ser un número entero mayor a cero');
  // Usa el método de pago enviado o el valor por defecto efectivo.
  const metodo = cuerpo.metodo || 'efectivo';
  // Valida que el método pertenezca a la lista permitida.
  if (!METODOS.includes(metodo)) throw falla(400, 'Método de pago inválido');
  // Establece una fecha por defecto a la hora actual.
  let fecha = new Date();
  // Si la solicitud trae fecha, la valida y asegura que no sea futura.
  if (cuerpo.fecha) {
    fecha = new Date(cuerpo.fecha);
    if (Number.isNaN(fecha.getTime())) throw falla(400, 'La fecha del pago no es válida');
    if (fecha.getTime() > Date.now() + 86400000) throw falla(400, 'La fecha del pago no puede ser futura');
  }
  // Devuelve los datos normalizados para crear el movimiento.
  return { monto, metodo, fecha, fechaSolicitada: cuerpo.fecha ? fecha.toISOString() : null, referencia: String(cuerpo.referencia || '').trim(), nota: String(cuerpo.nota || '').trim() };
};

/** Responde reintentos confirmados sin registrar otro movimiento. */
// Busca un pago anterior con la misma clave y huella para permitir idempotencia.
const pagoAnterior = async (clave, huella) => {
  // Busca un pago con la clave de idempotencia entregada por el cliente.
  const anterior = await Pago.findOne({ claveIdempotencia: clave }).lean();
  // Si no existe ninguna, no hay duplicado.
  if (!anterior) return null;
  // Si existe, se compara la huella para asegurar que la misma operación se reintente de forma segura.
  if (!anterior.huellaSolicitud || anterior.huellaSolicitud !== huella) {
    throw falla(409, 'La clave de idempotencia ya pertenece a una solicitud diferente o anterior sin huella');
  }
  // Devuelve el pago previo para devolverlo como respuesta duplicada.
  return anterior;
};
// Verifica si ya se registró una operación idéntica y devuelve la respuesta duplicada si aplica.
const respuestaDuplicada = async (req, res, huella) => {
  // Consulta el pago previo con la clave actual y la huella de la operación.
  const anterior = await pagoAnterior(claveDePago(req), huella);
  // Si no existe, retorna falso y la operación continua.
  if (!anterior) return false;
  // Si existe, responde 200 con el pago ya registrado y la marca repetida.
  res.status(200).json({ ...(await poblar(Pago.findById(anterior._id)).lean()), repetida: true });
  // Indica que la operación ya fue manejada.
  return true;
};
// Popula el usuario que registró el movimiento para devolver su nombre en la respuesta.
const poblar = (consulta) => consulta.populate('registradoPor', 'nombre');

// POST /api/pagos/cobro  { documentoId, monto, metodo?, fecha?, referencia?, nota? }   (abono de un cliente)
/**
 * Controlador registrarCobro: procesa la solicitud HTTP y envía una respuesta JSON.
 * @param {import("express").Request} req Solicitud con parámetros, cuerpo y usuario autenticado.
 * @param {import("express").Response} res Respuesta HTTP.
 */
// Registra un cobro a un cliente y valida que la factura tenga saldo disponible.
exports.registrarCobro = async (req, res) => {
  try {
    // Lee la clave de idempotencia para evitar registros duplicados por reintentos.
    const claveIdempotencia = claveDePago(req);
    // Normaliza los datos del pago recibidos en el cuerpo.
    const datos = leerDatos(req.body);
    // Valida que el identificador de la factura sea un ObjectId de Mongo válido.
    if (!idValido(req.body.documentoId)) throw falla(400, 'Factura inválida');
    // Genera una huella de la operación para detectar duplicados con el mismo payload.
    const huellaSolicitud = huellaOperacion('cobro', req.body.documentoId, datos);
    // Si ya existe una operación idéntica, responde con el pago registrado y termina.
    if (await respuestaDuplicada(req, res, huellaSolicitud)) return;

    // Ejecuta toda la lógica dentro de una transacción para mantener integridad financiera.
    const pago = await conTransaccion(async (session) => {
      // Escritura sobre la factura: las transacciones concurrentes compiten por el mismo documento.
      // MongoDB aborta/reintenta una de ellas y el saldo se vuelve a leer dentro de la transacción.
      const doc = await Documento.findByIdAndUpdate(req.body.documentoId, { $inc: { __v: 1 } }, { new: true, session });
      // Si la factura no existe, falla con 404.
      if (!doc) throw falla(404, 'Factura no encontrada');
      // Solo las facturas tienen cartera. Las remisiones no se pagan por este flujo.
      if (doc.tipo !== 'factura') throw falla(400, 'Solo las facturas tienen cartera: una remisión no se paga');
      // No se permiten pagos sobre facturas anuladas.
      if (doc.estado !== 'emitida') throw falla(400, 'No se pueden registrar pagos en una factura anulada');

      // Calcula el saldo pendiente de la factura antes de aceptar el cobro.
      const saldo = saldoDeFactura(doc);
      // Si la factura ya está saldada, no admite más abonos.
      if (saldo <= 0) throw falla(400, 'Esta factura ya está pagada por completo');
      // El cobro no puede exceder el saldo pendiente.
      if (datos.monto > saldo) throw falla(400, `El abono (${pesos(datos.monto)}) supera el saldo pendiente (${pesos(saldo)})`);

      // Carga la configuración del sistema para obtener prefijos y numeración.
      const config = await cargarConfig();
      // Obtiene el siguiente número correlativo para recibos.
      const consecutivo = await siguiente('recibo', session);
      // Crea la entidad de pago con la información financiera y de seguimiento.
      const [nuevo] = await Pago.create([{
        tipo: 'cobro', numero: formatear(config.prefijoRecibo || 'RC', consecutivo),
        documento: doc._id, clienteRef: doc.clienteRef, contraparte: doc.cliente.nombre, referenciaDocumento: doc.numero,
        ...{ monto: datos.monto, metodo: datos.metodo, fecha: datos.fecha, referencia: datos.referencia, nota: datos.nota }, claveIdempotencia, huellaSolicitud, registradoPor: req.usuario.id
      }], sesion(session));
      // Actualiza el saldo y el estado de la factura para reflejar el abono.
      await recalcularFactura(doc._id, session);
      // Devuelve el pago recién creado.
      return nuevo;
    });
    // Responde con el pago creado y el usuario que lo registró.
    res.status(201).json(await poblar(Pago.findById(pago._id)).lean());
  } catch (error) {
    // Maneja colisiones de clave idempotencia o concurrencia duplicada con un error 409 claro.
    if (error.code === 11000) return res.status(409).json({ mensaje: 'Clave ya registrada o solicitud concurrente; consulta el historial y reintenta con la misma clave y datos' });
    // Llama al manejador central de errores del controlador.
    responderError(res, error, 'Error al registrar el pago');
  }
};

// POST /api/pagos/reembolso  { documentoId, monto, metodo?, fecha?, referencia?, nota? }
// Devuelve dinero a un cliente que pagó de más porque una nota crédito bajó el valor de su factura.
/**
 * Controlador registrarReembolso: procesa la solicitud HTTP y envía una respuesta JSON.
 * @param {import("express").Request} req Solicitud con parámetros, cuerpo y usuario autenticado.
 * @param {import("express").Response} res Respuesta HTTP.
 */
// Registra una devolución de dinero al cliente cuando hay saldo a favor por documentos contables.
exports.registrarReembolso = async (req, res) => {
  try {
    // Valida y obtiene la clave de idempotencia para evitar duplicados por reintentos del cliente.
    const claveIdempotencia = claveDePago(req);
    // Normaliza el monto y demás datos del reembolso recibidos en el request.
    const datos = leerDatos(req.body);
    // Verifica que el ID del documento sea válido.
    if (!idValido(req.body.documentoId)) throw falla(400, 'Factura inválida');
    // Calcula la huella de la operación para comparar reintentos idénticos.
    const huellaSolicitud = huellaOperacion('reembolso', req.body.documentoId, datos);
    // Si ya existe el mismo movimiento, responde con el pago previo y termina.
    if (await respuestaDuplicada(req, res, huellaSolicitud)) return;

    // Ejecuta el reembolso dentro de una transacción para asegurar consistencia del saldo.
    const pago = await conTransaccion(async (session) => {
      // Escritura sobre la factura: las transacciones concurrentes compiten por el mismo documento.
      // MongoDB aborta/reintenta una de ellas y el saldo se vuelve a leer dentro de la transacción.
      const doc = await Documento.findByIdAndUpdate(req.body.documentoId, { $inc: { __v: 1 } }, { new: true, session });
      // Si la factura no existe, responde 404.
      if (!doc) throw falla(404, 'Factura no encontrada');
      // Solo se permiten reembolsos sobre facturas emitidas y vigentes.
      if (doc.tipo !== 'factura' || doc.estado !== 'emitida') throw falla(400, 'Solo se reembolsa dinero de facturas vigentes');

      // Calcula cuánto dinero tiene a favor el cliente sobre la factura.
      const aFavor = saldoAFavorDe(doc);
      // Si no hay saldo a favor, no se puede reembolsar.
      if (aFavor <= 0) throw falla(400, 'Esta factura no tiene saldo a favor del cliente');
      // El reembolso no puede superar el saldo a favor.
      if (datos.monto > aFavor) throw falla(400, `El reembolso (${pesos(datos.monto)}) supera el saldo a favor del cliente (${pesos(aFavor)})`);

      // Carga la configuración del sistema para obtener prefijos y numeración.
      const config = await cargarConfig();
      // Obtiene el siguiente número consecutivo del tipo reembolso.
      const consecutivo = await siguiente('reembolso', session);
      // Crea el movimiento de reembolso con su referencia documentaria y datos del cliente.
      const [nuevo] = await Pago.create([{
        tipo: 'reembolso', numero: formatear(config.prefijoReembolso || 'RE', consecutivo),
        documento: doc._id, clienteRef: doc.clienteRef, contraparte: doc.cliente.nombre, referenciaDocumento: doc.numero,
        ...{ monto: datos.monto, metodo: datos.metodo, fecha: datos.fecha, referencia: datos.referencia, nota: datos.nota }, claveIdempotencia, huellaSolicitud, registradoPor: req.usuario.id
      }], sesion(session));
      // Recalcula el saldo de la factura para reflejar el nuevo reembolso.
      await recalcularFactura(doc._id, session);
      // Devuelve el reembolso recién registrado.
      return nuevo;
    });
    // Responde con el reembolso registrado en JSON.
    res.status(201).json(await poblar(Pago.findById(pago._id)).lean());
  } catch (error) {
    // Si hay conflicto de clave de idempotencia o concurrencia, responde 409.
    if (error.code === 11000) return res.status(409).json({ mensaje: 'Clave ya registrada o solicitud concurrente; consulta el historial y reintenta con la misma clave y datos' });
    // Llama al manejador central de errores del controlador.
    responderError(res, error, 'Error al registrar el reembolso');
  }
};

// POST /api/pagos/egreso  { ordenId, monto, ... }   (pago a un proveedor; solo admin)
/**
 * Controlador registrarEgreso: procesa la solicitud HTTP y envía una respuesta JSON.
 * @param {import("express").Request} req Solicitud con parámetros, cuerpo y usuario autenticado.
 * @param {import("express").Response} res Respuesta HTTP.
 */
// Registra un egreso para pagar a un proveedor por una orden en curso.
exports.registrarEgreso = async (req, res) => {
  try {
    // Lee la clave de idempotencia para evitar pagos duplicados por reintentos.
    const claveIdempotencia = claveDePago(req);
    // Normaliza el monto y los datos generales del pago.
    const datos = leerDatos(req.body);
    // Verifica que el identificador de la orden de compra sea válido.
    if (!idValido(req.body.ordenId)) throw falla(400, 'Orden de compra inválida');
    // Genera la huella de la operación para detectar entradas duplicadas.
    const huellaSolicitud = huellaOperacion('egreso', req.body.ordenId, datos);
    // Si ya hubo un egreso idéntico, responde con el movimiento ya registrado.
    if (await respuestaDuplicada(req, res, huellaSolicitud)) return;

    // Ejecuta el pago dentro de una transacción para prevenir inconsistencias concurrentes.
    const pago = await conTransaccion(async (session) => {
      // Serializa los egresos de una misma orden mediante conflicto de escritura transaccional.
      const orden = await OrdenCompra.findByIdAndUpdate(req.body.ordenId, { $inc: { __v: 1 } }, { new: true, session }).populate('proveedor', 'nombre');
      // Si la orden no existe, responde 404.
      if (!orden) throw falla(404, 'Orden de compra no encontrada');
      // Solo permiten egresos sobre órdenes en estados que representan recibo o envío efectivo.
      if (!['enviada', 'parcial', 'recibida'].includes(orden.estado)) throw falla(400, 'Solo se pagan órdenes enviadas o recibidas');

      // Calcula el saldo por pagar de la orden antes de iniciar el egreso.
      const saldo = saldoDeOrden(orden);
      // Si la orden ya está pagada, no acepta más egresos.
      if (saldo <= 0) throw falla(400, 'No hay saldo por pagar: se paga el valor de la mercancía ya recibida');
      // El pago no puede exceder lo que se debe por la mercancía recibida.
      if (datos.monto > saldo) throw falla(400, `El pago (${pesos(datos.monto)}) supera lo que se debe por lo recibido (${pesos(saldo)})`);

      // Carga la configuración para obtener la numeración del egreso.
      const config = await cargarConfig();
      // Obtiene el próximo número consecutivo de egreso.
      const consecutivo = await siguiente('egreso', session);
      // Crea el movimiento de egreso con la información del proveedor y la orden.
      const [nuevo] = await Pago.create([{
        tipo: 'egreso', numero: formatear(config.prefijoEgreso || 'CE', consecutivo),
        orden: orden._id, proveedor: orden.proveedor._id, contraparte: orden.proveedor.nombre, referenciaDocumento: orden.numero,
        ...{ monto: datos.monto, metodo: datos.metodo, fecha: datos.fecha, referencia: datos.referencia, nota: datos.nota }, claveIdempotencia, huellaSolicitud, registradoPor: req.usuario.id
      }], sesion(session));
      // Recalcula el monto pagado de la orden para reflejar la operación.
      await recalcularOrden(orden._id, session);
      // Devuelve el egreso creado.
      return nuevo;
    });
    // Responde con el pago al proveedor registrado.
    res.status(201).json(await poblar(Pago.findById(pago._id)).lean());
  } catch (error) {
    // Maneja conflictos de clave o concurrencia duplicada con un error 409.
    if (error.code === 11000) return res.status(409).json({ mensaje: 'Clave ya registrada o solicitud concurrente; consulta el historial y reintenta con la misma clave y datos' });
    // Centraliza el tratamiento de errores de negocio o internos.
    responderError(res, error, 'Error al registrar el pago al proveedor');
  }
};

// PATCH /api/pagos/:id/anular  { motivo }   (solo admin)
/**
 * Controlador anular: procesa la solicitud HTTP y envía una respuesta JSON.
 * @param {import("express").Request} req Solicitud con parámetros, cuerpo y usuario autenticado.
 * @param {import("express").Response} res Respuesta HTTP.
 */
// Anula un movimiento financiero y recalcula el documento u orden afectada.
exports.anular = async (req, res) => {
  try {
    // Valida que el id del pago sea un ObjectId de Mongo comprimible / correcto.
    if (!idValido(req.params.id)) throw falla(400, 'Identificador inválido');
    // Lee el motivo de anulación y exige un texto suficientemente explicativo.
    const motivo = String(req.body.motivo || '').trim();
    if (motivo.length < 5) throw falla(400, 'Escribe el motivo de la anulación (mínimo 5 caracteres)');

    // Ejecuta la anulación dentro de una transacción para mantener integridad de saldos.
    await conTransaccion(async (session) => {
      // Busca el pago por id con la sesión actual.
      const pago = await Pago.findById(req.params.id).session(session || null);
      // Si no existe el pago, lanza error 404.
      if (!pago) throw falla(404, 'Pago no encontrado');
      // Evita anular dos veces el mismo pago.
      if (pago.estado === 'anulado') throw falla(400, 'Este pago ya está anulado');
      // Actualiza el estado del movimiento y registra la fecha y razón de anulación.
      pago.estado = 'anulado';
      pago.anuladoEn = new Date();
      pago.motivoAnulacion = motivo;
      // Guarda la anulación.
      await pago.save(sesion(session));
      // Si el movimiento pertenece a una factura, recalcula su saldo y estado de pago.
      if (pago.documento) await recalcularFactura(pago.documento, session);
      // Si el movimiento pertenece a una orden, recalcula el monto pagado de la compra.
      if (pago.orden) await recalcularOrden(pago.orden, session);
    });
    // Devuelve el pago anulado con los datos actualizados.
    res.json(await poblar(Pago.findById(req.params.id)).lean());
  } catch (error) {
    // Centraliza el manejo de errores y devuelve la respuesta HTTP adecuada.
    responderError(res, error, 'Error al anular el pago');
  }
};

// GET /api/pagos?tipo=cobro|egreso&metodo=&estado=&desde=&hasta=&buscar=
/**
 * Controlador listar: procesa la solicitud HTTP y envía una respuesta JSON.
 * @param {import("express").Request} req Solicitud con parámetros, cuerpo y usuario autenticado.
 * @param {import("express").Response} res Respuesta HTTP.
 */
// Devuelve una lista paginada y resumida de movimientos financieros con filtros por tipo, método y rango de fechas.
exports.listar = async (req, res) => {
  try {
    // Selecciona el tipo de movimiento. Si no viene, por defecto son cobros.
    const tipo = req.query.tipo === 'egreso' ? 'egreso' : 'cobro';
    // Solo administradores pueden listar egresos; los vendedores solo ven cobros y reembolsos.
    if (tipo === 'egreso' && req.usuario.role !== 'admin') throw falla(403, 'No autorizado para esta acción');

    // Construye el rango de fechas solicitado por la query para limitar la búsqueda.
    const rango = rangoDesdeQuery(req.query);
    // La vista de "cobros" incluye los reembolsos a clientes: el recaudo real es lo cobrado menos lo devuelto.
    const filtro = { tipo: tipo === 'cobro' ? { $in: ['cobro', 'reembolso'] } : tipo, fecha: { $gte: rango.desde, $lt: rango.hasta } };
    // Si el cliente filtra por método de pago, lo aplica al criterio de búsqueda.
    if (METODOS.includes(req.query.metodo)) filtro.metodo = req.query.metodo;
    // Si solicita filtrar por estado, lo añade al filtro.
    if (['vigente', 'anulado'].includes(req.query.estado)) filtro.estado = req.query.estado;
    // Si viene un texto de búsqueda, busca en cédulas, números y referencias relevantes.
    if (req.query.buscar) {
      const patron = { $regex: req.query.buscar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filtro.$or = [{ numero: patron }, { contraparte: patron }, { referenciaDocumento: patron }, { referencia: patron }];
    }

    // Si el usuario es vendedor, restringe los documentos a los que tiene permisos.
    if (esVentas(req)) filtro.documento = { $in: await documentosPropios(req) };
    // Si existe alcance de sucursales, filtra pagos por los pedidos de la sucursal autorizada.
    if (req.alcanceSucursales !== null) {
      const pedidosSede = await require('../models/Pedido').find(alcanceSede.filtro(req)).distinct('_id');
      const documentosSede = await Documento.find({ pedido: { $in: pedidosSede } }).distinct('_id');
      filtro.documento = { $in: filtro.documento?.$in
        ? documentosSede.filter(id => filtro.documento.$in.some(propio => String(propio) === String(id)))
        : documentosSede };
    }
    // Consulta los pagos, ordenados por fecha más reciente y luego por creación.
    const pagos = await poblar(Pago.find(filtro).sort({ fecha: -1, createdAt: -1 })).lean();
    // Filtra los pagos vigentes para resumir el estado actual.
    const vigentes = pagos.filter((p) => p.estado === 'vigente');
    // El signo distingue reembolsos (negativos) de cobros y egresos (positivos).
    const signo = (p) => (p.tipo === 'reembolso' ? -1 : 1);
    // Agrega el resumen agrupado por método de pago.
    const porMetodo = METODOS.map((metodo) => {
      const lista = vigentes.filter((p) => p.metodo === metodo);
      return { metodo, monto: lista.reduce((s, p) => s + signo(p) * p.monto, 0), cantidad: lista.length };
    }).filter((m) => m.cantidad > 0);
    // Extrae el total de reembolsos para mostrarlo en el resumen.
    const reembolsos = vigentes.filter((p) => p.tipo === 'reembolso');

    // Devuelve el resumen financiero, la lista filtrada y la bandera de truncado para la respuesta JSON.
    res.json({
      rango: { desde: rango.claveDesde, hasta: rango.claveHasta, dias: rango.dias.length },
      resumen: {
        total: vigentes.reduce((s, p) => s + signo(p) * p.monto, 0), cantidad: vigentes.length, anulados: pagos.length - vigentes.length, porMetodo,
        reembolsos: reembolsos.reduce((s, p) => s + p.monto, 0), cantidadReembolsos: reembolsos.length
      },
      pagos: pagos.slice(0, LIMITE_FILAS).map((p) => ({
        _id: p._id, numero: p.numero, tipo: p.tipo, fecha: p.fecha, contraparte: p.contraparte, referenciaDocumento: p.referenciaDocumento,
        documento: p.documento, orden: p.orden, monto: p.monto, metodo: p.metodo, referencia: p.referencia, nota: p.nota,
        estado: p.estado, motivoAnulacion: p.motivoAnulacion, registradoPor: p.registradoPor?.nombre ?? null
      })),
      truncado: pagos.length > LIMITE_FILAS
    });
  } catch (error) {
    // Reutiliza el manejo global de errores del controlador.
    responderError(res, error, 'Error al obtener los pagos');
  }
};

// GET /api/pagos/documento/:id  y  /api/pagos/orden/:id
// Devuelve la colección de pagos asociada a un documento o a una orden de compra.
const pagosDe = (campo) => async (req, res) => {
  try {
    // Valida el id del documento u orden antes de consultar la base de datos.
    if (!idValido(req.params.id)) throw falla(400, 'Identificador inválido');
    // Las órdenes solo pueden ser consultadas por administradores.
    if (campo === 'orden' && req.usuario.role !== 'admin') throw falla(403, 'No autorizado para esta acción');
    // Consulta los pagos relacionados con el documento u orden indicado.
    res.json(await poblar(Pago.find({ [campo]: req.params.id }).sort({ fecha: -1, createdAt: -1 })).lean());
  } catch (error) {
    // Devuelve el error apropiado si la consulta falla.
    responderError(res, error, 'Error al obtener los pagos');
  }
};
// Exporta el acceso por documento y por orden.
exports.porDocumento = pagosDe('documento');
exports.porOrden = pagosDe('orden');

// GET /api/pagos/:id - detalle para imprimir el recibo (incluye el saldo actual de la factura u orden)
/**
 * Controlador obtener: procesa la solicitud HTTP y envía una respuesta JSON.
 * @param {import("express").Request} req Solicitud con parámetros, cuerpo y usuario autenticado.
 * @param {import("express").Response} res Respuesta HTTP.
 */
// Busca un pago específico y agrega el saldo actual del documento o de la orden asociada.
exports.obtener = async (req, res) => {
  try {
    // Valida el identificador del pago.
    if (!idValido(req.params.id)) throw falla(400, 'Identificador inválido');
    // Carga el pago y el usuario que lo registró.
    const pago = await poblar(Pago.findById(req.params.id)).lean();
    // Si no existe el registro, responde 404.
    if (!pago) throw falla(404, 'Pago no encontrado');
    // Los egresos solo pueden verse por administradores.
    if (pago.tipo === 'egreso' && req.usuario.role !== 'admin') throw falla(403, 'No autorizado para esta acción');
    // Si hay restricción por sucursal, comprueba que el pedido origen pertenezca al alcance autorizado.
    if (req.alcanceSucursales !== null) {
      // No confiar en el campo sucursal del pago: resolver el pedido de origen.
      const doc = pago.documento && await Documento.findById(pago.documento).select('pedido').lean();
      const pedido = doc?.pedido && await require('../models/Pedido').findById(doc.pedido).select('sucursal').lean();
      if (!pedido?.sucursal || !req.alcanceSucursales.includes(String(pedido.sucursal))) throw falla(404, 'Pago no encontrado');
    }

    // Prepara el saldo actual de la cuenta financiera asociada.
    let cuenta = null;
    // Si el movimiento está asociado a una factura, obtiene su saldo actual.
    if (pago.documento) {
      const doc = await Documento.findById(pago.documento).select('numero total pagado formaPago').lean();
      if (doc) cuenta = { numero: doc.numero, total: doc.total, pagado: doc.pagado ?? 0, saldo: saldoDeFactura(doc) };
    } else if (pago.orden) {
      // Si el movimiento pertenece a una orden, calcula el total pagado y el saldo pendiente.
      const orden = await OrdenCompra.findById(pago.orden).select('numero items pagado').lean();
      if (orden) cuenta = { numero: orden.numero, total: orden.items.reduce((s, i) => s + (i.cantidadRecibida || 0) * i.costoUnitario, 0), pagado: orden.pagado || 0, saldo: saldoDeOrden(orden) };
    }
    // Devuelve el pago con su cuenta asociada para impresión o consulta detallada.
    res.json({ ...pago, cuenta });
  } catch (error) {
    // Maneja errores de validación o de consulta con la respuesta estándar.
    responderError(res, error, 'Error al obtener el pago');
  }
};

// Exporta las funciones de recalculo para que otros módulos puedan reutilizarlas.
exports.recalcularFactura = recalcularFactura;
exports.recalcularOrden = recalcularOrden;
// Exporta la lista de métodos permitidos para validar consumidores externos y pruebas.
exports.METODOS = METODOS;
