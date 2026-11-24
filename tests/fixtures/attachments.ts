import { crc32, deflateRawSync } from 'node:zlib'
import { createCanvas } from '@napi-rs/canvas'

/**
 * Generadores del corpus de pruebas de adjuntos (Fase 8). Todo se crea en memoria con datos conocidos:
 * no hay binarios opacos en el repositorio y cada prueba sabe qué texto debe salir.
 */

export interface ZipEntry {
  name: string
  data?: Buffer | string
  /** true = comprimido (deflate); por defecto se guarda sin comprimir */
  deflate?: boolean
  /** Enlace simbólico (atributos Unix) */
  symlink?: boolean
}

/** ZIP mínimo (PKZIP 2.0) con nombres UTF-8. Permite nombres peligrosos a propósito para probar la extracción. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8')
    const body = e.deflate ? deflateRawSync(raw) : raw
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(e.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // creado en Unix: los atributos externos llevan el modo
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(e.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** DOCX con un título y párrafos. */
export function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('')
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    { name: 'word/document.xml', deflate: true, data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
  ])
}

/** XLSX con varias hojas (cadenas en línea y números). */
export function makeXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Buffer {
  const col = (i: number) => String.fromCharCode(65 + i)
  const sheetXml = (rows: (string | number)[][]) =>
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r
            .map((v, ci) => (typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`))
            .join('')}</row>`,
      )
      .join('')}</sheetData></worksheet>`
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`,
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, deflate: true, data: sheetXml(s.rows) })),
  ])
}

/** PDF 1.4 a mano. Cada página es un flujo de contenido; `images` añade JPEG (DCTDecode) a pantalla completa. */
function buildPdf(pages: { content: string; image?: { jpeg: Buffer; w: number; h: number } }[]): Buffer {
  const W = 595
  const H = 842
  const objs: Buffer[] = []
  const add = (b: Buffer | string) => objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')) // devuelve nº de objeto
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('') // Pages (se rellena al final)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const kids: number[] = []
  for (const p of pages) {
    let imgRef = ''
    if (p.image) {
      const head = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${p.image.w} /Height ${p.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.image.jpeg.length} >>\nstream\n`, 'latin1')
      add(Buffer.concat([head, p.image.jpeg, Buffer.from('\nendstream', 'latin1')]))
      imgRef = `/XObject << /Im1 ${objs.length} 0 R >>`
    }
    const stream = p.image ? `q ${W} 0 0 ${H} 0 0 cm /Im1 Do Q` : p.content
    add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
    const contentRef = objs.length
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R >> ${imgRef} >> /Contents ${contentRef} 0 R >>`)
    kids.push(objs.length)
  }
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1')
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let len = parts[0]!.length
  objs.forEach((o, i) => {
    offsets.push(len)
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')])
    parts.push(chunk)
    len += chunk.length
  })
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}

/** PDF con capa de texto: una página por elemento, cada línea separada por \n. */
export function makeTextPdf(pages: string[]): Buffer {
  const pdfStr = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  return buildPdf(pages.map((t) => ({ content: `BT /F1 14 Tf 72 770 Td 18 TL ${t.split('\n').map((l) => `(${pdfStr(l)}) Tj T*`).join(' ')} ET` })))
}

/** Imagen con texto grande y nítido (para OCR y visión). */
export function renderTextImage(lines: string[], opts: { width?: number; height?: number; format?: 'png' | 'jpeg' | 'webp' } = {}): Buffer {
  const w = opts.width ?? 1240
  const h = opts.height ?? 1754
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#000000'
  const size = Math.round(Math.min(w / 22, h / (lines.length * 1.6 + 1)))
  ctx.font = `${size}px sans-serif`
  lines.forEach((l, i) => ctx.fillText(l, w * 0.08, size * 1.5 + i * size * 1.6))
  const fmt = opts.format ?? 'png'
  return fmt === 'png' ? canvas.toBuffer('image/png') : fmt === 'jpeg' ? canvas.toBuffer('image/jpeg', 90) : canvas.toBuffer('image/webp', 90)
}

/** PDF «escaneado»: cada página es solo una imagen JPEG del texto, sin capa de texto. */
export function makeScannedPdf(pages: string[][]): Buffer {
  return buildPdf(pages.map((lines) => ({ content: '', image: { jpeg: renderTextImage(lines, { format: 'jpeg' }), w: 1240, h: 1754 } })))
}
