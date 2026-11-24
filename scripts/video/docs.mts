/**
 * Documentos de ejemplo del vídeo (empresa FICTICIA «Quesos del Prado S.L.»): base de conocimiento y una factura.
 *   node scripts/video/docs.mts <carpeta>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makeDocx, makeTextPdf, makeXlsx } from '../../tests/fixtures/attachments.ts'

const out = process.argv[2]
if (!out) throw new Error('Uso: node scripts/video/docs.mts <carpeta>')
const kb = path.join(out, 'Documentos Quesos del Prado')
mkdirSync(path.join(kb, 'Procedimientos'), { recursive: true })

writeFileSync(
  path.join(kb, 'Procedimientos', 'Pagos a proveedores.docx'),
  makeDocx([
    'Procedimiento de pagos (revisión 2026).',
    'El plazo de pago a proveedores nacionales es de 60 días desde la fecha de factura. Para proveedores extranjeros el plazo es de 90 días.',
    'Los pagos se emiten los días 10 y 25 de cada mes.',
    'Las facturas de más de 6.000 € necesitan la firma de la directora financiera, Marta Ibáñez.',
  ]),
)
writeFileSync(
  path.join(kb, 'Procedimientos', 'Devoluciones.docx'),
  makeDocx([
    'Política de devoluciones de clientes.',
    'Los clientes pueden devolver mercancía en un plazo de 15 días naturales desde la entrega.',
    'El producto refrigerado solo se acepta si tiene un defecto, enviando fotos en las primeras 48 horas.',
  ]),
)
writeFileSync(
  path.join(kb, 'Clientes.xlsx'),
  makeXlsx([
    {
      name: 'Clientes',
      rows: [
        ['Cliente', 'Código SAP', 'País', 'Condición de pago'],
        ['ALCAMPO', 400123, 'España', '60 días'],
        ['CARREFOUR', 400187, 'España', '90 días'],
        ['TESCO STORES', 410552, 'Reino Unido', '45 días'],
        ['COVIRAN', 400301, 'España', '30 días'],
      ],
    },
  ]),
)
writeFileSync(
  path.join(kb, 'Tarifas 2026.xlsx'),
  makeXlsx([
    { name: 'Quesos', rows: [['Producto', 'Precio por kg (€)'], ['Manchego curado', 12.5], ['Manchego semicurado', 10.8], ['Queso fresco', 4.2]] },
    { name: 'Portes', rows: [['Zona', 'Coste del porte (€)'], ['Península', 35], ['Baleares', 85], ['Canarias', 'no se sirve']] },
  ]),
)
writeFileSync(
  path.join(kb, 'Calendario laboral 2026.pdf'),
  makeTextPdf(['Calendario laboral 2026 de Quesos del Prado S.L.', 'Las vacaciones de verano se solicitan antes del 31 de marzo.\nLa empresa cierra del 10 al 16 de agosto.\nHorario de verano: de 8:00 a 15:00 del 1 de julio al 31 de agosto.']),
)
writeFileSync(path.join(kb, 'Transportistas.txt'), 'Transportistas habituales.\n\nTransportes Hermanos Gil: recogidas los lunes y jueves.\nFrigoríficos del Tajo: recogidas diarias salvo domingo; lleva el producto refrigerado.\n')

writeFileSync(
  path.join(out, 'Factura F-2026-0412.pdf'),
  makeTextPdf([
    'FACTURA F-2026-0412\nQuesos del Prado S.L. - CIF B00000000 (ficticio)\nCliente: Ultramarinos La Esquina\nFecha: 18/11/2026',
    'Manchego curado - 20 kg x 12,50 EUR = 250,00 EUR\nQueso fresco - 30 kg x 4,20 EUR = 126,00 EUR\nBase imponible: 376,00 EUR\nIVA 4 %: 15,04 EUR\nTOTAL: 391,04 EUR\nVencimiento: 18/12/2026',
  ]),
)
console.log(`Documentos en ${out}`)
