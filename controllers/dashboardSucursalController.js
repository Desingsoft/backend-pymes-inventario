/** Panel operativo para usuarios de sucursal: nunca expone cifras globales ni financieras. */
const Bodega = require('../models/Bodega');
const Existencia = require('../models/Existencia');
const Producto = require('../models/Producto');
const Pedido = require('../models/Pedido');
const { filtro } = require('../middlewares/alcanceSucursal');
const ESTADOS = ['pendiente', 'procesando', 'enviado', 'completado', 'cancelado'];
function nivel(stock, minimo) {
  if (stock <= 0) return 'agotado';
  if (stock <= minimo / 2) return 'critico';
  if (stock <= minimo) return 'bajo';
  return 'saludable';
}
module.exports = async (req, res, next) => {
  try {
    const dias = Math.min(Math.max(Number.parseInt(req.query.dias, 10) || 14, 7), 90);
    const alcance = filtro(req);
    const bodegas = await Bodega.find({ sucursal: alcance.sucursal }).select('_id').lean();
    const existencias = await Existencia.find({ bodega: { $in: bodegas.map(b => b._id) } }).select('producto cantidad').lean();
    const cantidades = new Map();
    for (const e of existencias) cantidades.set(String(e.producto), (cantidades.get(String(e.producto)) || 0) + e.cantidad);
    const productos = await Producto.find({ _id: { $in: [...cantidades.keys()] }, activo: true })
      .select('nombre sku stockMinimo').lean();
    const estadoInventario = { agotado: 0, critico: 0, bajo: 0, saludable: 0 };
    const conNivel = productos.map(p => {
      const stock = cantidades.get(String(p._id)) || 0;
      const n = nivel(stock, p.stockMinimo);
      estadoInventario[n]++;
      return { _id: p._id, nombre: p.nombre, sku: p.sku, stock, stockMinimo: p.stockMinimo, nivel: n };
    });
    const hace30 = new Date(Date.now() - 30 * 86400000);
    const [pendientes, procesando, conteos] = await Promise.all([
      Pedido.countDocuments({ ...alcance, estado: 'pendiente' }),
      Pedido.countDocuments({ ...alcance, estado: 'procesando' }),
      Promise.all(ESTADOS.map(estado => Pedido.countDocuments({ ...alcance, estado, createdAt: { $gte: hace30 } })))
    ]);
    res.json({
      generadoEn: new Date().toISOString(), dias,
      kpis: {
        ventasPeriodo: null, ventasPeriodoAnterior: null, variacionVentas: null,
        pedidosPeriodo: null, ticketPromedio: null, devolucionesPeriodo: null,
        pedidosPendientes: pendientes, pedidosProcesando: procesando,
        productosActivos: productos.length,
        unidadesEnStock: [...cantidades.values()].reduce((s, n) => s + n, 0),
        productosEnAlerta: estadoInventario.agotado + estadoInventario.critico + estadoInventario.bajo,
        valorInventario: null, carteraPorCobrar: null, carteraVencida: null,
        facturasVencidas: null, cuentasPorPagar: null, cuentasPorPagarVencidas: null
      },
      estadoInventario,
      pedidosPorEstado: ESTADOS.map((estado, i) => ({ estado, cantidad: conteos[i] })),
      ventasPorDia: null, topProductos: null,
      atencion: conNivel.filter(p => p.nivel !== 'saludable').slice(0, 6)
    });
  } catch (error) { next(error); }
};
