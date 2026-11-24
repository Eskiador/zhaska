import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { decodeText, detectKind, extract, parseCsv, unsafeZipName, type ExtractJob } from '../../src/main/attachments/extract'
import { AttachmentService } from '../../src/main/services/attachments'
import { migrate, openDatabase } from '../../src/main/db/database'
import { AttachmentsRepo, ConversationsRepo, ProjectsRepo } from '../../src/main/db/repos'
import { toolByName, type ToolContext } from '../../src/agent/tools/registry'
import { makeDocx, makeScannedPdf, makeTextPdf, makeXlsx, makeZip, renderTextImage } from '../fixtures/attachments'

const MODULES = resolve('node_modules')
const ASSETS = {
  pdfFontsDir: join(MODULES, 'pdfjs-dist', 'standard_fonts') + sep,
  ocrSources: ['eng', 'spa'].map((l) => join(MODULES, '@tesseract.js-data', l, '4.0.0_best_int', `${l}.traineddata.gz`)),
}

/** Servicio real (SQLite temporal, extracción en este hilo) con un Ollama simulado solo para las capacidades. */
function setup(opts: { vision?: boolean; models?: { name: string; vision: boolean }[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zh-att-'))
  const db = openDatabase(join(dir, 'z.db'))
  migrate(db)
  const events: { id: string; status: string; progress?: string }[] = []
  const described: string[] = []
  const models = opts.models ?? []
  const fakeOllama = {
    show: async (m: string) => ({ capabilities: m === 'principal' ? (opts.vision ? ['completion', 'vision'] : ['completion']) : models.find((x) => x.name === m)?.vision ? ['vision'] : ['completion'] }),
    tags: async () => ({ models: models.map((m) => ({ name: m.name })) }),
    chatOnce: async (body: { model: string }) => {
      described.push(body.model)
      return { message: { role: 'assistant', content: 'Una captura con el texto ERROR 42.' }, done: true }
    },
  }
  const svc = new AttachmentService({
    repo: new AttachmentsRepo(db),
    root: join(dir, 'attachments'),
    ocrDir: join(dir, 'ocr'),
    workerPath: null,
    assets: ASSETS,
    ollama: () => fakeOllama as never,
    emit: (r) => events.push({ id: r.id, status: r.status, progress: r.progress }),
  })
  const projects = new ProjectsRepo(db)
  const conversations = new ConversationsRepo(db)
  const project = projects.touchByRoot(join(dir, 'proyecto'), 'p')
  const conv = conversations.create(project.id)
  return { dir, db, svc, events, described, conversations, conv }
}

async function uploadReady(svc: AttachmentService, name: string, data: Buffer | string) {
  const row = await svc.upload(name, new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data)))
  for (let i = 0; i < 600 && svc.get([row.id])[0]!.status === 'processing'; i++) await new Promise((r) => setTimeout(r, 50))
  return svc.get([row.id])[0]!
}

describe('detección de formato y texto', () => {
  it('comprueba magic bytes y rechaza binarios desconocidos', () => {
    expect(detectKind(Buffer.from('%PDF-1.7\n'), 'pdf')).toBe('pdf')
    expect(() => detectKind(Buffer.from('hola'), 'pdf')).toThrow(/no corresponde a un archivo \.pdf/)
    expect(() => detectKind(Buffer.from('%PDF-1.4'), 'png')).toThrow(/\.png/)
    expect(detectKind(Buffer.from('const a = 1\n'), 'ts')).toBe('code')
    expect(detectKind(Buffer.from('clave=valor\n'), 'properties')).toBe('text')
    expect(() => detectKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]), 'bin')).toThrow(/binario/)
  })

  it('detecta UTF-8, UTF-16 y Windows-1252', () => {
    expect(decodeText(Buffer.from('añadir ñandú', 'utf8'))).toMatchObject({ text: 'añadir ñandú', encoding: 'UTF-8' })
    expect(decodeText(Buffer.from([0xff, 0xfe, ...Buffer.from('café', 'utf16le')]))).toMatchObject({ text: 'café', encoding: 'UTF-16 LE' })
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toMatchObject({ text: 'café', encoding: 'Windows-1252' })
  })

  it('CSV con punto y coma, comillas y saltos de línea dentro de celdas', () => {
    expect(parseCsv('nombre;nota\n"Pérez; Ana";"dice ""hola""\nadiós"\nLuis;7\n')).toEqual([
      ['nombre', 'nota'],
      ['Pérez; Ana', 'dice "hola"\nadiós'],
      ['Luis', '7'],
    ])
  })
})

describe('ZIP seguro', () => {
  it('nombres peligrosos', () => {
    expect(unsafeZipName('src/a.ts')).toBeNull()
    expect(unsafeZipName('../fuera.txt')).toMatch(/salir/)
    expect(unsafeZipName('a/../../b')).toMatch(/salir/)
    expect(unsafeZipName('/etc/passwd')).toMatch(/absoluta/)
    expect(unsafeZipName('C:/Windows/x.dll')).toMatch(/absoluta/)
    expect(unsafeZipName('..\\..\\x')).toMatch(/salir/)
    expect(unsafeZipName('docs/CON.txt')).toMatch(/reservado/)
    expect(unsafeZipName('a.txt:secreto')).toMatch(/flujo/)
  })

  it('extrae solo lo seguro de un ZIP malicioso', async () => {
    const { svc, dir } = setup()
    const bomb = Buffer.alloc(30 * 1024 * 1024, 0) // 30 MB de ceros → ~30 KB comprimido
    const zip = makeZip([
      { name: 'proyecto/README.md', data: '# Hola\nProyecto de prueba' },
      { name: 'proyecto/src/index.js', data: 'console.log("hola")\n' },
      { name: '../../fuera.txt', data: 'escapé' },
      { name: '/tmp/absoluto.txt', data: 'x' },
      { name: 'enlace', data: '/etc/passwd', symlink: true },
      { name: 'bomba.bin', data: bomb, deflate: true },
      { name: 'programa.exe', data: 'MZ' },
      { name: 'otro.zip', data: makeZip([{ name: 'dentro.txt', data: 'anidado' }]) },
      { name: 'NUL.txt', data: 'x' },
    ])
    const a = await uploadReady(svc, 'codigo.zip', zip)
    expect(a.status).toBe('ready')
    expect(a.meta.entries).toBe(3) // README, index.js y el zip anidado (sin expandir)
    expect(a.meta.rejected).toBe(6)
    expect(a.meta.warnings?.join(' ')).toMatch(/bomba ZIP/)
    const p = await svc.preview(a.id)
    const byPath = Object.fromEntries(p.entries!.map((e) => [e.path, e]))
    expect(byPath['../../fuera.txt']).toMatchObject({ status: 'rejected' })
    expect(byPath['enlace']!.reason).toMatch(/simbólico/)
    expect(byPath['bomba.bin']!.reason).toMatch(/bomba/)
    expect(byPath['programa.exe']).toMatchObject({ status: 'skipped' })
    expect(byPath['otro.zip']!.reason).toMatch(/anidado/)
    expect(p.text).toContain('console.log("hola")')
    // Nada se escribió fuera de la carpeta de extracción
    expect(existsSync(join(dir, 'fuera.txt'))).toBe(false)
    expect(existsSync('/tmp/absoluto.txt') && readFileSync('/tmp/absoluto.txt', 'utf8') === 'x').toBe(false)
    const unzipped = join(svc.dirOf(svcSha(svc, a.id)), 'unzipped')
    expect(readdirSync(unzipped).sort()).toEqual(['otro.zip', 'proyecto'])
  })

  it('rechaza un ZIP con demasiadas entradas sin extraer nada', async () => {
    const { svc } = setup()
    const entries = Array.from({ length: 10_001 }, (_, i) => ({ name: `f${i}.txt`, data: '' }))
    const a = await uploadReady(svc, 'muchos.zip', makeZip(entries))
    expect(a.status).toBe('error')
    expect(a.error).toMatch(/10001 entradas/)
  })
})

/** sha256 de un adjunto (solo para las pruebas). */
function svcSha(svc: AttachmentService, id: string): string {
  return (svc as unknown as { deps: { repo: AttachmentsRepo } }).deps.repo.get(id).sha256
}

describe('documentos', () => {
  it('PDF con texto, DOCX y XLSX con varias hojas', async () => {
    const { svc } = setup()
    const pdf = await uploadReady(svc, 'informe.pdf', makeTextPdf(['Informe trimestral\nVentas: 1200 euros', 'Conclusiones finales']))
    expect(pdf).toMatchObject({ status: 'ready', kind: 'pdf', meta: { pages: 2 } })
    expect(pdf.meta.ocr).toBeUndefined()
    const pdfText = (await svc.preview(pdf.id)).text!
    expect(pdfText).toContain('--- Página 1 ---')
    expect(pdfText).toContain('Ventas: 1200 euros')
    expect(pdfText).toContain('Conclusiones finales')

    const docx = await uploadReady(svc, 'acta.docx', makeDocx(['Acta de la reunión', 'Se aprueba el presupuesto de 2027.']))
    expect(docx.status).toBe('ready')
    expect((await svc.preview(docx.id)).text).toMatch(/Acta de la reunión\s+Se aprueba el presupuesto de 2027\./)

    const xlsx = await uploadReady(
      svc,
      'ventas.xlsx',
      makeXlsx([
        { name: 'Ventas', rows: [['Mes', 'Importe'], ['Enero', 1200], ['Febrero', 980.5]] },
        { name: 'Gastos', rows: [['Concepto', 'Coste'], ['Luz, agua', 80]] },
      ]),
    )
    expect(xlsx.meta.sheets).toEqual([
      { name: 'Ventas', rows: 3, cols: 2 },
      { name: 'Gastos', rows: 2, cols: 2 },
    ])
    const prev = await svc.preview(xlsx.id)
    expect(prev.sheets!.map((s) => s.name)).toEqual(['Ventas', 'Gastos'])
    expect(prev.sheets![0]!.rows[2]).toEqual(['Febrero', '980.5'])
    expect(prev.text).toContain('## Hoja «Gastos» (2 filas × 2 columnas)')
    expect(prev.text).toContain('"Luz, agua",80')
  })

  it('PDF escaneado: se lee con OCR', async () => {
    const { svc } = setup()
    const a = await uploadReady(svc, 'escaneado.pdf', makeScannedPdf([['FACTURA 2026', 'Total: 1.250 EUR'], ['Gracias por su compra']]))
    expect(a.status).toBe('ready')
    expect(a.meta.pages).toBe(2)
    expect(a.meta.ocr?.pages).toBe(2)
    expect(a.meta.ocr!.confidence).toBeGreaterThan(70)
    const text = (await svc.preview(a.id)).text!
    expect(text).toContain('[Texto reconocido por OCR]')
    expect(text).toMatch(/FACTURA 2026/)
    expect(text).toMatch(/Gracias por su compra/)
  }, 60_000)

  it('rechaza contenido que no coincide con la extensión y formatos no admitidos', async () => {
    const { svc } = setup()
    const fake = await uploadReady(svc, 'falso.pdf', 'esto no es un pdf')
    expect(fake).toMatchObject({ status: 'error', error: expect.stringMatching(/no corresponde/) })
    const old = await svc.upload('antiguo.doc', new Uint8Array([1, 2, 3]))
    expect(old).toMatchObject({ status: 'error', error: expect.stringMatching(/\.docx/) })
    const empty = await svc.upload('vacio.txt', new Uint8Array())
    expect(empty.error).toMatch(/vacío/)
  })
})

describe('imágenes', () => {
  it('miniatura, copia para visión y OCR (PNG, WEBP y SVG)', async () => {
    const { svc } = setup()
    const png = await uploadReady(svc, 'captura.png', renderTextImage(['TypeError: x is undefined', 'at main.js:12'], { width: 1400, height: 400 }))
    expect(png).toMatchObject({ status: 'ready', kind: 'image', meta: { width: 1400, height: 400, hasThumb: true, hasVision: true } })
    expect(png.thumb).toMatch(/^data:image\/jpeg;base64,/)
    const prev = await svc.preview(png.id)
    expect(prev.image).toMatch(/^data:image\/jpeg;base64,/)
    expect(prev.text).toMatch(/TypeError/)

    const webp = await uploadReady(svc, 'foto.webp', renderTextImage(['Hola'], { width: 600, height: 300, format: 'webp' }))
    expect(webp).toMatchObject({ status: 'ready', meta: { width: 600, height: 300 } })

    const svg = await uploadReady(svc, 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#8E87FF"/></svg>')
    expect(svg).toMatchObject({ status: 'ready', kind: 'image', meta: { width: 64, height: 32 } })
    expect((await svc.preview(svg.id)).text).toContain('Código SVG')
  }, 60_000)
})

describe('servicio de adjuntos', () => {
  it('deduplica por contenido, no deja borrar lo enviado y limpia al quitar', async () => {
    const { svc, conversations, conv } = setup()
    const a = await uploadReady(svc, 'notas.md', '# Notas\n- uno\n')
    const b = await svc.upload('copia.md', new Uint8Array(Buffer.from('# Notas\n- uno\n')))
    expect(b.status).toBe('ready') // misma extracción, sin volver a procesar
    expect(svcSha(svc, a.id)).toBe(svcSha(svc, b.id))
    const msg = conversations.addMessage(conv.id, 'user', [{ kind: 'text', text: 'mira' }])
    svc.link(msg.id, [a.id])
    await expect(svc.remove(a.id)).rejects.toThrow(/historial/)
    await svc.remove(b.id)
    expect(existsSync(svc.dirOf(svcSha(svc, a.id)))).toBe(true) // sigue en uso por a
    expect(svc.forConversation(conv.id).map((x) => x.id)).toEqual([a.id])
  })

  it('al enviar: valida el estado y prepara el contexto', async () => {
    const { svc, conv } = setup()
    const doc = await uploadReady(svc, 'largo.txt', 'línea de prueba\n'.repeat(2000))
    expect(() => svc.validateForSend([doc.id, 'no-existe'])).toThrow(/ya no existe/)
    const bad = await uploadReady(svc, 'roto.pdf', 'no')
    expect(() => svc.validateForSend([bad.id])).toThrow(/quítalo/)
    const ctx = await svc.forModel({ ids: [doc.id], conversationId: conv.id, model: 'principal', visionSetting: 'auto', budgetChars: 3000, tools: true })
    expect(ctx.text).toContain('[Adjunto 1] largo.txt')
    expect(ctx.text).toContain('usa read_attachment con name="largo.txt" y offset=3000')
    expect(ctx.refs).toHaveLength(1)
    expect(ctx.images).toEqual([])
  })

  it('imágenes: visión nativa, modelo auxiliar o aviso claro (nunca simulado)', async () => {
    const img = renderTextImage(['ERROR 42'], { width: 500, height: 200 })
    // 1) El modelo principal ve imágenes: se adjunta la imagen
    let s = setup({ vision: true })
    let a = await uploadReady(s.svc, 'error.png', img)
    let ctx = await s.svc.forModel({ ids: [a.id], conversationId: s.conv.id, model: 'principal', visionSetting: 'auto', budgetChars: 10_000, tools: true })
    expect(ctx.images).toHaveLength(1)
    expect(ctx.text).toContain('La imagen va adjunta')
    // 2) No ve imágenes, pero hay otro modelo local con visión: lo describe y se indica
    s = setup({ vision: false, models: [{ name: 'texto:1b', vision: false }, { name: 'gemma4:e4b', vision: true }] })
    a = await uploadReady(s.svc, 'error.png', img)
    ctx = await s.svc.forModel({ ids: [a.id], conversationId: s.conv.id, model: 'principal', visionSetting: 'auto', budgetChars: 10_000, tools: true })
    expect(ctx.images).toEqual([])
    expect(s.described).toEqual(['gemma4:e4b'])
    expect(ctx.text).toContain('Descripción generada por el modelo de visión gemma4:e4b')
    // 3) Ninguno: aviso explícito y solo el OCR
    s = setup({ vision: false })
    a = await uploadReady(s.svc, 'error.png', img)
    ctx = await s.svc.forModel({ ids: [a.id], conversationId: s.conv.id, model: 'principal', visionSetting: 'auto', budgetChars: 10_000, tools: true })
    expect(ctx.text).toContain('no puede ver imágenes y no hay ningún modelo de visión instalado')
    expect(ctx.text).toMatch(/ERROR 42/)
  }, 60_000)
})

describe('read_attachment (agente)', () => {
  it('lee por nombre con offset, dentro de un ZIP y nunca fuera', async () => {
    const { svc, conv } = setup()
    const txt = await uploadReady(svc, 'Datos.csv', `a,b\n${'1,2\n'.repeat(5000)}`)
    const zip = await uploadReady(svc, 'src.zip', makeZip([{ name: 'app/main.py', data: 'print("hola")\n' }]))
    const { refs } = await svc.forModel({ ids: [txt.id, zip.id], conversationId: conv.id, model: 'principal', visionSetting: 'off', budgetChars: 5000, tools: true })
    const tool = toolByName('read_attachment')!
    const ctx = { attachments: refs, output: () => {} } as unknown as ToolContext
    const run = (args: Record<string, unknown>) => tool.execute(tool.schema.parse(args), ctx)

    const first = await run({ name: 'datos.csv' })
    expect(first.ok).toBe(true)
    expect(first.output).toMatch(/caracteres 0–10000 de 20004/)
    expect(first.output).toContain('usa offset=10000')
    expect((await run({ name: 'Datos.csv', offset: 20000 })).output).toContain('1,2')
    expect((await run({ name: 'src.zip', path: 'app/main.py' })).output).toContain('print("hola")')
    expect((await run({ name: 'src.zip', path: 'app' })).output).toBe('main.py')
    expect((await run({ name: 'src.zip', path: '../../extracted.txt' })).output).toMatch(/fuera del ZIP/)
    expect((await run({ name: 'Datos.csv', path: 'x' })).output).toMatch(/no es un ZIP/)
    expect((await run({ name: 'otro.pdf' })).output).toMatch(/Adjuntos disponibles: Datos\.csv, src\.zip/)
  })
})

describe('extracción directa', () => {
  it('escribe extracted.txt y devuelve los caracteres', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zh-ext-'))
    const file = join(dir, 'original.tsv')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, 'a\tb\n1\t2\n')
    const job: ExtractJob = { file, ext: 'tsv', dir, ocrDataDir: dir, ocrCacheDir: dir, pdfFontsDir: ASSETS.pdfFontsDir }
    const r = await extract(job)
    expect(r).toMatchObject({ kind: 'sheet', meta: { chars: 8, sheets: [{ name: 'Datos', rows: 2, cols: 2 }] } })
    expect(readFileSync(join(dir, 'extracted.txt'), 'utf8')).toBe('a\tb\n1\t2\n')
    void deflateRawSync
  })
})
