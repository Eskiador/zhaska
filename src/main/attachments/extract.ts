import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { unsafeZipName } from '@core/security/zipNames'
import { ATTACHMENT_LIMITS, kindOfExt, type AttachmentKind, type AttachmentMetaInfo } from '@shared/attachments'

/**
 * Extracción de contenido de adjuntos (ARCHITECTURE §8). Todo es local: pdfjs, mammoth, read-excel-file,
 * tesseract.js (datos eng+spa empaquetados) y yauzl. Se ejecuta en un worker_thread (ver worker.ts);
 * estas funciones no dependen de Electron para poder probarlas con un corpus real.
 *
 * Salida en `dir`: extracted.txt (texto para el modelo), y según el tipo thumb.jpg, vision.jpg,
 * sheets.json (vista previa de hojas), entries.json y unzipped/ (ZIP).
 */

export class ExtractError extends Error {}

export interface ExtractJob {
  file: string
  ext: string
  dir: string
  /** Carpeta con eng.traineddata.gz y spa.traineddata.gz */
  ocrDataDir: string
  ocrCacheDir: string
  /** Carpeta standard_fonts de pdfjs-dist (se normaliza con fontsDirUrl) */
  pdfFontsDir: string
}

export interface ExtractResult {
  kind: AttachmentKind
  meta: AttachmentMetaInfo
}

type Progress = (message: string) => void

// ───────────────────────── Detección de formato ─────────────────────────

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v)

/** Comprueba que el contenido corresponde a la extensión (magic bytes). Devuelve el tipo real. */
export function detectKind(head: Buffer, ext: string): AttachmentKind {
  const kind = kindOfExt(ext)
  const isZip = startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])
  const mismatch = () => new ExtractError(`El contenido no corresponde a un archivo .${ext}.`)
  switch (ext) {
    case 'pdf':
      if (!head.subarray(0, 1024).includes('%PDF-')) throw mismatch()
      return kind
    case 'docx':
    case 'xlsx':
    case 'zip':
      if (!isZip) throw mismatch()
      return kind
    case 'png':
      if (!startsWith(head, [0x89, 0x50, 0x4e, 0x47])) throw mismatch()
      return kind
    case 'jpg':
    case 'jpeg':
      if (!startsWith(head, [0xff, 0xd8, 0xff])) throw mismatch()
      return kind
    case 'webp':
      if (!(head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')) throw mismatch()
      return kind
    case 'gif':
      if (!/^GIF8[79]a/.test(head.subarray(0, 6).toString('latin1'))) throw mismatch()
      return kind
    case 'svg':
      if (isBinary(head) || !/<svg[\s>]/i.test(decodeText(head).text)) throw mismatch()
      return kind
  }
  // Texto, código y extensiones desconocidas: solo si el contenido es texto
  if (isBinary(head)) throw new ExtractError(kind === 'other' ? 'Formato no compatible: el archivo es binario y no se puede analizar de forma segura.' : `El contenido no corresponde a un archivo de texto .${ext}.`)
  return kind === 'other' ? 'text' : kind
}

export function isBinary(b: Buffer): boolean {
  if (startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])) return false // UTF-16 con BOM
  const n = Math.min(b.length, 8000)
  for (let i = 0; i < n; i++) if (b[i] === 0) return true
  return false
}

/** UTF-8 (con o sin BOM), UTF-16 con BOM o, si no es UTF-8 válido, Windows-1252. */
export function decodeText(b: Buffer): { text: string; encoding: string } {
  if (startsWith(b, [0xef, 0xbb, 0xbf])) return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'UTF-8 (BOM)' }
  if (startsWith(b, [0xff, 0xfe])) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'UTF-16 LE' }
  if (startsWith(b, [0xfe, 0xff])) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'UTF-16 BE' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(b), encoding: 'Windows-1252' }
  }
}

// ───────────────────────── CSV ─────────────────────────

/** Parser CSV (RFC 4180) con detección de separador: coma, punto y coma, tabulador o barra. */
export function parseCsv(text: string, ext = 'csv'): string[][] {
  const firstLine = text.slice(0, 4000).split(/\r?\n/)[0] ?? ''
  const sep = ext === 'tsv' ? '\t' : ([',', ';', '\t', '|'] as const).map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0]
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().replace(/T00:00:00\.000Z$/, '')
  return String(v)
}

// ───────────────────────── OCR ─────────────────────────

type OcrWorker = { recognize: (img: Buffer) => Promise<{ data: { text: string; confidence: number } }>; terminate: () => Promise<unknown> }
let ocr: { key: string; worker: Promise<OcrWorker>; idle?: NodeJS.Timeout } | null = null

/**
 * pdfjs decide al cargarse si está en Node mirando `process.type`: en un utilityProcess de Electron vale
 * «utility» y pdfjs se cree en un navegador (pide un Web Worker y un DOM que no existen). Mientras se evalúa el
 * módulo se le muestra «browser», que es lo que ve en el proceso principal, y después se restaura.
 */
/**
 * pdfjs exige que la carpeta de fuentes acabe en «/» y en Windows `path.sep` es «\\» (lanzaba «Invalid factory
 * url» y ningún PDF se leía). En Node la lee con fs.readFile, que en Windows acepta «C:/…» con barras normales.
 */
export function fontsDirUrl(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/?$/, '/')
}

let pdfjsModule: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null
function importPdfjs() {
  pdfjsModule ??= (async () => {
    const proc = process as unknown as { type?: string }
    const original = Object.getOwnPropertyDescriptor(process, 'type')
    const patch = !!process.versions['electron'] && !!proc.type && proc.type !== 'browser'
    if (patch) Object.defineProperty(process, 'type', { value: 'browser', configurable: true, enumerable: true, writable: true })
    try {
      return await import('pdfjs-dist/legacy/build/pdf.mjs')
    } finally {
      if (patch) {
        if (original) Object.defineProperty(process, 'type', original)
        else delete proc.type
      }
    }
  })()
  return pdfjsModule
}

/**
 * En la app instalada tesseract.js está dentro del ASAR, pero lanza su OCR en un worker_thread, que no puede
 * leer el ASAR: se le indica la copia desempaquetada (app.asar.unpacked, ver electron-builder.yml).
 */
function tesseractWorkerPath(): string | undefined {
  if (!process.versions['electron'] || typeof __filename === 'undefined') return undefined
  try {
    const dir = path.dirname(createRequire(__filename).resolve('tesseract.js/package.json'))
    return path.join(dir, 'src', 'worker-script', 'node', 'index.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  } catch {
    return undefined
  }
}

async function ocrImage(job: ExtractJob, png: Buffer): Promise<{ text: string; confidence: number }> {
  const key = `${job.ocrDataDir}|${job.ocrCacheDir}`
  if (!ocr || ocr.key !== key) {
    const { createWorker } = await import('tesseract.js')
    const workerPath = tesseractWorkerPath()
    ocr = { key, worker: createWorker(['spa', 'eng'], 1, { langPath: job.ocrDataDir, cachePath: job.ocrCacheDir, gzip: true, logger: () => {}, ...(workerPath ? { workerPath } : {}) } as never) as unknown as Promise<OcrWorker> }
  }
  const current = ocr
  if (current.idle) clearTimeout(current.idle)
  const r = await (await current.worker).recognize(png)
  // El worker de OCR ocupa ~100 MB: se libera tras un minuto sin uso
  current.idle = setTimeout(() => {
    if (ocr === current) ocr = null
    void current.worker.then((w) => w.terminate())
  }, 60_000)
  current.idle.unref()
  return { text: r.data.text.trim(), confidence: r.data.confidence }
}

// ───────────────────────── PDF ─────────────────────────

async function extractPdf(job: ExtractJob, data: Buffer, progress: Progress) {
  const pdfjs = await importPdfjs()
  // pdfjs 6 ya no evalúa código del PDF; sin fuentes del sistema ni FontFace (solo se extrae texto)
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false, enableXfa: false, standardFontDataUrl: fontsDirUrl(job.pdfFontsDir), verbosity: 0 })
  let doc
  try {
    doc = await task.promise
  } catch (e) {
    if ((e as Error).name === 'PasswordException') throw new ExtractError('El PDF está protegido con contraseña.')
    throw new ExtractError(`No se pudo leer el PDF: ${(e as Error).message}`)
  }
  const warnings: string[] = []
  const parts: string[] = []
  let ocrPages = 0
  let ocrConfidence = 0
  for (let n = 1; n <= doc.numPages; n++) {
    progress(`Leyendo página ${n} de ${doc.numPages}`)
    const page = await doc.getPage(n)
    const tc = await page.getTextContent()
    let text = tc.items
      .map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : ''))
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .trim()
    if (text.replace(/\s/g, '').length < 10) {
      // Página sin capa de texto (escaneada): se dibuja y se pasa por OCR
      if (ocrPages < ATTACHMENT_LIMITS.ocrPages) {
        progress(`Reconociendo texto (OCR) en la página ${n} de ${doc.numPages}`)
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: Math.min(3, Math.max(1.5, 2000 / base.width)) })
        const { createCanvas } = await import('@napi-rs/canvas')
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport }).promise
        const r = await ocrImage(job, canvas.toBuffer('image/png'))
        ocrPages++
        ocrConfidence += r.confidence
        text = r.text ? `[Texto reconocido por OCR]\n${r.text}` : '[Página sin texto reconocible]'
      } else if (ocrPages === ATTACHMENT_LIMITS.ocrPages) {
        warnings.push(`Solo se reconocieron con OCR las primeras ${ATTACHMENT_LIMITS.ocrPages} páginas escaneadas.`)
        ocrPages++
      }
    }
    parts.push(`--- Página ${n} ---\n${text}`)
    page.cleanup()
  }
  const pages = doc.numPages
  await task.destroy()
  const realOcr = Math.min(ocrPages, ATTACHMENT_LIMITS.ocrPages)
  return { text: parts.join('\n\n'), meta: { pages, ...(realOcr ? { ocr: { pages: realOcr, confidence: Math.round(ocrConfidence / realOcr) } } : {}), warnings } satisfies AttachmentMetaInfo }
}

// ───────────────────────── DOCX / XLSX ─────────────────────────

async function extractDocx(data: Buffer) {
  const mammoth = await import('mammoth')
  try {
    const r = await mammoth.extractRawText({ buffer: data })
    return { text: r.value.replace(/\n{3,}/g, '\n\n').trim(), meta: {} satisfies AttachmentMetaInfo }
  } catch (e) {
    throw new ExtractError(`No se pudo leer el documento: ${(e as Error).message}`)
  }
}

const PREVIEW_ROWS = 200
const PREVIEW_COLS = 40

async function extractXlsx(dir: string, data: Buffer) {
  const { default: readXlsx } = await import('read-excel-file/node')
  let sheets: { sheet: string; data: unknown[][] }[]
  try {
    sheets = (await readXlsx(data)) as never
  } catch (e) {
    throw new ExtractError(`No se pudo leer la hoja de cálculo: ${(e as Error).message}`)
  }
  const info = sheets.map((s) => ({ name: s.sheet, rows: s.data.length, cols: Math.max(0, ...s.data.map((r) => r.length)) }))
  const text = sheets.map((s, i) => `## Hoja «${s.sheet}» (${info[i]!.rows} filas × ${info[i]!.cols} columnas)\n${s.data.map((r) => r.map((v) => csvCell(cellText(v))).join(',')).join('\n')}`).join('\n\n')
  await writeFile(path.join(dir, 'sheets.json'), JSON.stringify(sheets.map((s) => ({ name: s.sheet, rows: s.data.slice(0, PREVIEW_ROWS).map((r) => r.slice(0, PREVIEW_COLS).map(cellText)) }))))
  return { text, meta: { sheets: info } satisfies AttachmentMetaInfo }
}

async function extractCsv(dir: string, data: Buffer, ext: string) {
  const { text, encoding } = decodeText(data)
  const rows = parseCsv(text, ext)
  const cols = Math.max(0, ...rows.slice(0, 1000).map((r) => r.length))
  await writeFile(path.join(dir, 'sheets.json'), JSON.stringify([{ name: 'Datos', rows: rows.slice(0, PREVIEW_ROWS).map((r) => r.slice(0, PREVIEW_COLS)) }]))
  return { text, meta: { encoding, sheets: [{ name: 'Datos', rows: rows.length, cols }] } satisfies AttachmentMetaInfo }
}

// ───────────────────────── Imágenes ─────────────────────────

/** Miniatura (tarjetas), copia para visión (≤ 1568 px, JPEG) y OCR del texto que contenga la imagen. */
async function extractImage(job: ExtractJob, data: Buffer, progress: Progress) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  let img: Awaited<ReturnType<typeof loadImage>>
  try {
    img = await loadImage(data)
  } catch {
    throw new ExtractError('La imagen está dañada o no se puede decodificar.')
  }
  const width = img.width
  const height = img.height
  if (!width || !height) throw new ExtractError('La imagen no tiene dimensiones válidas.')
  const render = (max: number, bg: boolean) => {
    const s = Math.min(1, max / Math.max(width, height))
    const c = createCanvas(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)))
    const ctx = c.getContext('2d')
    if (bg) {
      // JPEG no tiene transparencia: fondo blanco para que PNG/SVG transparentes se vean bien
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, c.width, c.height)
    }
    ctx.drawImage(img, 0, 0, c.width, c.height)
    return c
  }
  await writeFile(path.join(job.dir, 'thumb.jpg'), render(320, true).toBuffer('image/jpeg', 80))
  await writeFile(path.join(job.dir, 'vision.jpg'), render(1568, true).toBuffer('image/jpeg', 85))
  const parts: string[] = []
  const meta: AttachmentMetaInfo = { width, height, hasThumb: true, hasVision: true }
  if (job.ext === 'svg') parts.push(`Código SVG:\n${decodeText(data).text.slice(0, 200_000)}`)
  else {
    progress('Reconociendo texto en la imagen (OCR)')
    // Margen blanco: tesseract reconoce peor el texto pegado al borde (capturas de pantalla)
    const src = render(3000, true)
    const pad = createCanvas(src.width + 40, src.height + 40)
    const pctx = pad.getContext('2d')
    pctx.fillStyle = '#ffffff'
    pctx.fillRect(0, 0, pad.width, pad.height)
    pctx.drawImage(src, 20, 20)
    const r = await ocrImage(job, pad.toBuffer('image/png'))
    const useful = r.text.replace(/\s/g, '').length >= 4 && r.confidence >= 50
    meta.ocr = { pages: 1, confidence: Math.round(r.confidence) }
    parts.push(useful ? `[Texto reconocido por OCR · confianza ${Math.round(r.confidence)} %]\n${r.text}` : '[La imagen no contiene texto legible por OCR]')
  }
  return { text: parts.join('\n\n'), meta }
}

// ───────────────────────── ZIP seguro (ARCHITECTURE §9.4) ─────────────────────────

const EXECUTABLE = new Set(['exe', 'dll', 'msi', 'scr', 'com', 'vbs', 'vbe', 'lnk', 'jar', 'app', 'dmg', 'pif', 'cpl', 'hta', 'sys', 'drv'])
const TEXT_INLINE_BYTES = 64 * 1024
const TEXT_INLINE_TOTAL = 300 * 1024

export interface ZipEntryInfo {
  path: string
  size: number
  status: 'ok' | 'rejected' | 'skipped'
  reason?: string
}

/** Motivo por el que un nombre de entrada no es seguro, o null. */
export { unsafeZipName }

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true, autoClose: true }, (err, zip) => (err ? reject(new ExtractError(`El ZIP está dañado: ${err.message}`)) : resolve(zip!))),
  )
}

export async function extractZip(job: ExtractJob, progress: Progress) {
  const out = path.join(job.dir, 'unzipped')
  await mkdir(out, { recursive: true })
  const zip = await openZip(job.file)
  if (zip.entryCount > ATTACHMENT_LIMITS.zipEntries) {
    zip.close()
    throw new ExtractError(`El ZIP tiene ${zip.entryCount} entradas (máximo ${ATTACHMENT_LIMITS.zipEntries}).`)
  }
  const entries: ZipEntryInfo[] = []
  const inline: string[] = []
  let inlineBytes = 0
  let total = 0
  let bomb = false

  await new Promise<void>((resolve, reject) => {
    zip.on('error', (e: Error) => reject(new ExtractError(`Error al leer el ZIP: ${e.message}`)))
    zip.on('end', () => resolve())
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileName as unknown as Buffer, entry.extraFields, false).replace(/\\/g, '/')
        const isDir = name.endsWith('/')
        const reject_ = (reason: string) => entries.push({ path: name, size: entry.uncompressedSize, status: 'rejected', reason })
        const unsafe = unsafeZipName(name)
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if (unsafe) reject_(unsafe)
        else if (mode === 0o120000) reject_('enlace simbólico')
        else if (entry.generalPurposeBitFlag & 0x1) reject_('cifrado con contraseña')
        else if (isDir) await mkdir(safeJoin(out, name), { recursive: true })
        else if (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize / Math.max(1, entry.compressedSize) > ATTACHMENT_LIMITS.zipRatio) {
          bomb = true
          reject_(`compresión sospechosa (${Math.round(entry.uncompressedSize / Math.max(1, entry.compressedSize))}:1, posible bomba ZIP)`)
        } else if (total + entry.uncompressedSize > ATTACHMENT_LIMITS.zipTotalBytes) {
          entries.push({ path: name, size: entry.uncompressedSize, status: 'skipped', reason: `se superan ${ATTACHMENT_LIMITS.zipTotalBytes / 1024 / 1024} MB descomprimidos` })
        } else if (EXECUTABLE.has(path.extname(name).slice(1).toLowerCase())) {
          entries.push({ path: name, size: entry.uncompressedSize, status: 'skipped', reason: 'ejecutable: no se extrae' })
        } else {
          const target = safeJoin(out, name)
          await mkdir(path.dirname(target), { recursive: true })
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s!))))
          await pipeline(stream, createWriteStream(target, { flags: 'wx' }))
          total += entry.uncompressedSize
          const nested = /\.zip$/i.test(name)
          entries.push({ path: name, size: entry.uncompressedSize, status: 'ok', ...(nested ? { reason: 'ZIP anidado: no se expande' } : {}) })
          if (!nested && entry.uncompressedSize <= TEXT_INLINE_BYTES && inlineBytes + entry.uncompressedSize <= TEXT_INLINE_TOTAL) {
            const buf = await readFile(target)
            if (!isBinary(buf)) {
              inline.push(`=== ${name} ===\n${decodeText(buf).text}`)
              inlineBytes += buf.length
            }
          }
        }
        if (entries.length % 50 === 0) progress(`Extrayendo ${entries.length} de ${zip.entryCount}`)
        zip.readEntry()
      })().catch((e) => {
        zip.close()
        reject(new ExtractError(`Error al extraer el ZIP: ${(e as Error).message}`))
      })
    })
    zip.readEntry()
  })

  await writeFile(path.join(job.dir, 'entries.json'), JSON.stringify(entries))
  const ok = entries.filter((e) => e.status === 'ok')
  const bad = entries.filter((e) => e.status !== 'ok')
  const warnings: string[] = []
  if (bomb) warnings.push('El ZIP contiene entradas con una compresión anómala (posible bomba ZIP): no se han extraído.')
  if (bad.length) warnings.push(`${bad.length} entrada${bad.length === 1 ? '' : 's'} no se extrajeron por seguridad o tamaño.`)
  const text = [
    `Contenido del ZIP: ${ok.length} archivo${ok.length === 1 ? '' : 's'} extraído${ok.length === 1 ? '' : 's'} (${(total / 1024).toFixed(0)} KB).`,
    ok.map((e) => `- ${e.path} (${e.size} bytes)${e.reason ? ` · ${e.reason}` : ''}`).join('\n'),
    bad.length ? `No extraídos:\n${bad.map((e) => `- ${e.path}: ${e.reason}`).join('\n')}` : '',
    inline.length ? `Contenido de los archivos de texto pequeños:\n\n${inline.join('\n\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { text, meta: { entries: ok.length, rejected: bad.length, warnings } satisfies AttachmentMetaInfo }
}

/** Une `name` a `root` y comprueba que el resultado sigue dentro (defensa adicional a unsafeZipName). */
export function safeJoin(root: string, name: string): string {
  const target = path.resolve(root, name)
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ExtractError(`Ruta fuera de la carpeta de extracción: ${name}`)
  return target
}

// ───────────────────────── Entrada ─────────────────────────

export async function extract(job: ExtractJob, progress: Progress = () => {}): Promise<ExtractResult> {
  const data = await readFile(job.file)
  const kind = detectKind(data.subarray(0, 8192), job.ext)
  let r: { text: string; meta: AttachmentMetaInfo }
  switch (kind) {
    case 'pdf':
      r = await extractPdf(job, data, progress)
      break
    case 'doc':
      r = await extractDocx(data)
      break
    case 'sheet':
      r = job.ext === 'xlsx' ? await extractXlsx(job.dir, data) : await extractCsv(job.dir, data, job.ext)
      break
    case 'image':
      r = await extractImage(job, data, progress)
      break
    case 'archive':
      r = await extractZip(job, progress)
      break
    default: {
      const { text, encoding } = decodeText(data)
      r = { text, meta: { encoding } }
    }
  }
  const text = r.text.replace(/\r\n/g, '\n')
  await writeFile(path.join(job.dir, 'extracted.txt'), text)
  if (!r.meta.warnings?.length) delete r.meta.warnings
  return { kind, meta: { ...r.meta, chars: text.length } }
}
