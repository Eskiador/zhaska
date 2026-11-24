import diagnostics from 'node:diagnostics_channel'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '../../src/main/db/database'
import { AttachmentsRepo, SettingsRepo } from '../../src/main/db/repos'
import { AttachmentService } from '../../src/main/services/attachments'
import { AssistantRepo, KnowledgeRepo } from '../../src/main/assistant/repos'
import { KnowledgeService } from '../../src/main/assistant/knowledge'
import { AssistantService } from '../../src/main/assistant/service'
import { OllamaClient } from '../../src/shared/ollama/client'
import { OllamaProvider } from '../../src/agent/providers/ollama'
import { NOT_FOUND_PHRASE, citedNumbers } from '../../src/shared/assistant'
import type { AssistantMessage } from '../../src/shared/ipc/contract'
import type { HostEvent, HostRequest } from '../../src/shared/agent/host'
import { makeDocx, makeTextPdf, makeXlsx } from '../fixtures/attachments'

/**
 * Evaluación del asistente de empresa (Fase 12) con modelos reales de Ollama, sobre los documentos de una
 * empresa FICTICIA (Quesos del Prado S.L.). Mide:
 *  - aciertos: la respuesta contiene el dato correcto;
 *  - citas correctas: lo que cita la respuesta es el documento que contiene el dato (objetivo ≥ 90 %);
 *  - datos inventados: en preguntas cuya respuesta NO está en los documentos, debe decir «No aparece en tus
 *    documentos» y no dar ningún dato (objetivo: ninguno);
 *  - red: ninguna petición fuera de 127.0.0.1.
 *   ZHASKA_EVAL_MODEL=gemma4:12b-it-qat npm run eval:agent -- tests/eval/assistant.eval.ts
 */
const MODEL = process.env['ZHASKA_EVAL_MODEL'] ?? 'gemma4:12b-it-qat'
const HOST = process.env['OLLAMA_HOST_URL'] ?? 'http://127.0.0.1:11434'
const MODULES = resolve('node_modules')

const DOCS: Record<string, Buffer | string> = {
  'procedimientos/pagos.docx': makeDocx([
    'Procedimiento de pagos (revisión 2026).',
    'El plazo de pago a proveedores nacionales es de 60 días desde la fecha de factura. Para proveedores extranjeros el plazo es de 90 días.',
    'Los pagos se emiten los días 10 y 25 de cada mes.',
    'Las facturas de más de 6.000 € necesitan la firma de la directora financiera, Marta Ibáñez.',
  ]),
  'procedimientos/devoluciones.docx': makeDocx([
    'Política de devoluciones de clientes.',
    'Los clientes pueden devolver mercancía en un plazo de 15 días naturales desde la entrega.',
    'El producto refrigerado solo se acepta si tiene un defecto, enviando fotos en las primeras 48 horas.',
    'El abono se hace con una nota de abono con el prefijo NA-. Responsable: departamento de Calidad, extensión 214.',
  ]),
  'clientes.xlsx': makeXlsx([
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
  'tarifas-2026.xlsx': makeXlsx([
    { name: 'Quesos', rows: [['Producto', 'Precio por kg (€)'], ['Manchego curado', 12.5], ['Manchego semicurado', 10.8], ['Queso fresco', 4.2]] },
    { name: 'Portes', rows: [['Zona', 'Coste del porte (€)'], ['Península', 35], ['Baleares', 85], ['Canarias', 'no se sirve']] },
  ]),
  'calendario-laboral.pdf': makeTextPdf([
    'Calendario laboral 2026 de Quesos del Prado S.L.',
    // Una línea por frase: el generador de PDF de las pruebas no parte las líneas largas (se saldrían de la página)
    'Las vacaciones de verano se solicitan antes del 31 de marzo.\nLa empresa cierra del 10 al 16 de agosto.\nEl horario de verano es de 8:00 a 15:00 del 1 de julio al 31 de agosto.',
  ]),
  'transportistas.txt': 'Transportistas habituales.\n\nTransportes Hermanos Gil: recogidas los lunes y jueves, teléfono 925 111 222.\nFrigoríficos del Tajo: recogidas diarias salvo domingo; es el que lleva el producto refrigerado.\n',
  'cargos-penalizaciones.md': '# Notas de cargo de clientes\n\nCuando un cliente emite una nota de cargo por penalización logística (PLOG), hay que reclamarla en un plazo de 10 días hábiles adjuntando el albarán firmado.\n\nLos cargos por promoción (PCAD) los valida el departamento comercial.\n',
  'otros/receta-tarta.txt': 'Receta de tarta de queso para la comida de Navidad: 500 g de queso fresco, 3 huevos y 200 g de azúcar.\n',
}

interface Q {
  q: string
  expect?: RegExp[]
  doc?: string
}

const ANSWERABLE: Q[] = [
  { q: '¿Cuál es el plazo de pago a proveedores extranjeros?', expect: [/90/], doc: 'pagos.docx' },
  { q: '¿Quién tiene que firmar las facturas de más de 6.000 euros?', expect: [/Marta Ib[aá]ñez/i], doc: 'pagos.docx' },
  { q: '¿Qué días del mes se emiten los pagos?', expect: [/10/, /25/], doc: 'pagos.docx' },
  { q: '¿Cuál es el código SAP de CARREFOUR?', expect: [/400187/], doc: 'clientes.xlsx' },
  { q: '¿Qué condición de pago tiene TESCO?', expect: [/45/], doc: 'clientes.xlsx' },
  { q: '¿A cuánto está el kilo de manchego curado?', expect: [/12[,.]5/], doc: 'tarifas-2026.xlsx' },
  { q: '¿Cuánto cuesta el porte a Baleares?', expect: [/85/], doc: 'tarifas-2026.xlsx' },
  { q: '¿Hasta cuándo se pueden pedir las vacaciones de verano?', expect: [/31 de marzo/i], doc: 'calendario-laboral.pdf' },
  { q: '¿Qué días cierra la empresa en agosto?', expect: [/10/, /16/], doc: 'calendario-laboral.pdf' },
  { q: '¿Qué transportista lleva el producto refrigerado?', expect: [/Frigor[ií]ficos del Tajo/i], doc: 'transportistas.txt' },
  { q: '¿En cuántos días hay que reclamar un cargo PLOG?', expect: [/10 d[ií]as/i], doc: 'cargos-penalizaciones.md' },
  { q: '¿Cuántos días tiene un cliente para devolver mercancía?', expect: [/15/], doc: 'devoluciones.docx' },
]

/** Preguntas cuya respuesta NO está en los documentos: debe decir que no aparece y no inventar */
const UNANSWERABLE: (Q & { forbidden: RegExp })[] = [
  { q: '¿Cuál es el teléfono del director general?', forbidden: /\d{3}\s?\d{3}\s?\d{3}/ },
  { q: '¿Cuál es el código SAP de MERCADONA?', forbidden: /\b4\d{5}\b/ },
  { q: '¿Cuánto cuesta el kilo de queso azul?', forbidden: /\d+[,.]\d+\s*(€|euros)/ },
  { q: '¿Qué condición de pago tiene el cliente LIDL?', forbidden: /\b\d+ d[ií]as\b/ },
]

const ASSETS = {
  pdfFontsDir: join(MODULES, 'pdfjs-dist', 'standard_fonts'),
  ocrSources: ['eng', 'spa'].map((l) => join(MODULES, '@tesseract.js-data', l, '4.0.0_best_int', `${l}.traineddata.gz`)),
}

const hosts = new Set<string>()
const onReq = ({ request }: { request: { origin: string } }) => hosts.add(new URL(request.origin).hostname)
diagnostics.subscribe('undici:request:create', onReq as never)

/** Directo a la salida (vitest oculta console.log en esta configuración) */
const log = (...a: unknown[]) => process.stdout.write(`${a.join(' ')}\n`)
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const results: { q: string; kind: 'sí' | 'no'; ok: boolean; citeOk: boolean | null; invented: boolean; ms: number; answer: string }[] = []

describe(`Asistente de empresa con ${MODEL}`, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zh-asst-eval-')))
  const docs = join(dir, 'documentos')
  for (const [rel, data] of Object.entries(DOCS)) {
    mkdirSync(join(docs, ...rel.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(docs, ...rel.split('/')), data)
  }
  const db = openDatabase(join(dir, 'z.db'))
  migrate(db)
  const client = new OllamaClient(HOST)
  const attachments = new AttachmentService({ repo: new AttachmentsRepo(db), root: join(dir, 'att'), ocrDir: join(dir, 'ocr'), workerPath: null, assets: ASSETS, ollama: () => client, emit: () => {} })
  const knowledge = new KnowledgeService({
    repo: new KnowledgeRepo(db),
    ollama: () => client,
    embedModel: () => 'embeddinggemma',
    extract: (file, ext, d) => attachments.extractText(file, ext, d),
    workDir: join(dir, 'kb-tmp'),
    folderProblem: () => null,
    emit: () => {},
    watch: false,
  })
  // Mismo camino de generación que el Agent Host (OllamaProvider), sin Electron
  const provider = new OllamaProvider(client)
  const listeners: ((e: HostEvent) => void)[] = []
  const host = {
    onEvent: (l: (e: HostEvent) => void) => listeners.push(l),
    onExit: () => {},
    send: (req: HostRequest) => {
      if (req.type !== 'chat.start') return
      void (async () => {
        let text = ''
        try {
          for await (const c of provider.chat({ model: req.model, messages: req.messages, numCtx: req.numCtx, temperature: req.temperature, think: req.think }, new AbortController().signal)) {
            if (c.type === 'text') text += c.text
            else if (c.type === 'done') listeners.forEach((l) => l({ type: 'chat.done', taskId: req.taskId, text, metrics: c.metrics } as HostEvent))
          }
        } catch (e) {
          listeners.forEach((l) => l({ type: 'chat.error', taskId: req.taskId, code: 'MODEL_ERROR', message: (e as Error).message, text } as HostEvent))
        }
      })()
    },
  }
  const settings = new SettingsRepo(db)
  settings.set('numCtx', 16384)
  const assistant = new AssistantService({ repo: new AssistantRepo(db), knowledge, settings, host: host as never, attachments, emit: () => {} })
  const [col] = knowledge.create('Quesos del Prado', false)
  const t0 = Date.now()
  knowledge.addFolder(col!.id, docs)
  await knowledge.idle()
  const indexMs = Date.now() - t0

  const ask = async (q: string): Promise<{ msg: AssistantMessage; ms: number }> => {
    const conv = assistant.create({ collectionIds: [col!.id], private: false })
    const start = Date.now()
    await assistant.send({ conversationId: conv.id, text: q, model: MODEL })
    for (;;) {
      await new Promise((r) => setTimeout(r, 200))
      const msgs = assistant.messages(conv.id)
      if (msgs.length === 2) return { msg: msgs[1]!, ms: Date.now() - start }
      if (Date.now() - start > 300_000) throw new Error('sin respuesta en 5 min')
    }
  }

  it('indexa los 8 documentos', () => {
    const list = knowledge.documents(col!.id)
    log(`Índice: ${list.length} documentos, ${list.reduce((s, d) => s + d.chunks, 0)} fragmentos en ${(indexMs / 1000).toFixed(1)} s`)
    expect(list.filter((d) => d.status === 'indexed')).toHaveLength(8)
  })

  for (const item of ANSWERABLE)
    it(`responde: ${item.q}`, async () => {
      const { msg, ms } = await ask(item.q)
      const blocks = msg.blocks as { kind: string; text?: string; items?: { n: number; name: string; cited: boolean }[] }[]
      const answer = blocks.find((b) => b.kind === 'text')?.text ?? ''
      const sources = blocks.find((b) => b.kind === 'sources')?.items ?? []
      const ok = item.expect!.every((re) => re.test(answer))
      const cited = sources.filter((s) => citedNumbers(answer).includes(s.n))
      const citeOk = cited.length ? cited.some((s) => s.name === item.doc) && cited.every((s) => s.name === item.doc || !/otros/.test(s.name)) : false
      results.push({ q: item.q, kind: 'sí', ok, citeOk, invented: false, ms, answer })
      log(`${ok ? '✓' : '✗'} ${citeOk ? 'cita bien' : 'cita mal  '} ${(ms / 1000).toFixed(1)} s · ${item.q}\n    → ${answer.replace(/\s+/g, ' ').slice(0, 160)}\n    fuentes citadas: ${cited.map((s) => s.name).join(', ') || '—'}`)
    })

  for (const item of UNANSWERABLE)
    it(`no inventa: ${item.q}`, async () => {
      const { msg, ms } = await ask(item.q)
      const answer = (msg.blocks as { kind: string; text?: string }[]).find((b) => b.kind === 'text')?.text ?? ''
      const says = norm(answer).includes(norm(NOT_FOUND_PHRASE))
      const invented = !says || item.forbidden.test(answer)
      results.push({ q: item.q, kind: 'no', ok: !invented, citeOk: null, invented, ms, answer })
      log(`${invented ? '✗ INVENTA' : '✓ no aparece'} ${(ms / 1000).toFixed(1)} s · ${item.q}\n    → ${answer.replace(/\s+/g, ' ').slice(0, 160)}`)
    })

  it('resumen: ≥ 90 % de citas correctas y ningún dato inventado', () => {
    const yes = results.filter((r) => r.kind === 'sí')
    const no = results.filter((r) => r.kind === 'no')
    expect(yes.filter((r) => r.citeOk).length / yes.length).toBeGreaterThanOrEqual(0.9)
    expect(no.filter((r) => r.invented)).toEqual([])
  })

  afterAll(() => {
    diagnostics.unsubscribe('undici:request:create', onReq as never)
    const yes = results.filter((r) => r.kind === 'sí')
    const no = results.filter((r) => r.kind === 'no')
    const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)} %` : '—')
    log(`\n══ ${MODEL} ══`)
    log(`Aciertos: ${yes.filter((r) => r.ok).length}/${yes.length} (${pct(yes.filter((r) => r.ok).length, yes.length)})`)
    log(`Citas correctas: ${yes.filter((r) => r.citeOk).length}/${yes.length} (${pct(yes.filter((r) => r.citeOk).length, yes.length)})`)
    log(`Sin respuesta en los documentos → «${NOT_FOUND_PHRASE}»: ${no.filter((r) => !r.invented).length}/${no.length}; datos inventados: ${no.filter((r) => r.invented).length}`)
    log(`Tiempo medio por respuesta: ${(results.reduce((s, r) => s + r.ms, 0) / Math.max(1, results.length) / 1000).toFixed(1)} s`)
    log(`Hosts contactados: ${[...hosts].join(', ')}`)
  })

  it('red: solo el Ollama de este equipo', () => {
    expect([...hosts].every((h) => h === '127.0.0.1')).toBe(true)
  })
})
