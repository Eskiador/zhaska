import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import diagnostics from 'node:diagnostics_channel'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '../../src/main/db/database'
import { AttachmentsRepo, SettingsRepo } from '../../src/main/db/repos'
import { AttachmentService } from '../../src/main/services/attachments'
import { AssistantRepo, KnowledgeRepo } from '../../src/main/assistant/repos'
import { KnowledgeService, listFiles } from '../../src/main/assistant/knowledge'
import { AssistantService, checkAnswer } from '../../src/main/assistant/service'
import { chunkText, fromBlob, ftsQuery, fuseRankings, toBlob, dot } from '../../src/main/assistant/text'
import { citedNumbers, NOT_FOUND_PHRASE, sourcesBlock, type AssistantSource } from '../../src/shared/assistant'
import { OllamaClient } from '../../src/shared/ollama/client'
import type { HostEvent, HostRequest } from '../../src/shared/agent/host'
import { makeDocx, makeTextPdf, makeXlsx } from '../fixtures/attachments'

const MODULES = resolve('node_modules')
const ASSETS = {
  pdfFontsDir: join(MODULES, 'pdfjs-dist', 'standard_fonts'),
  ocrSources: ['eng', 'spa'].map((l) => join(MODULES, '@tesseract.js-data', l, '4.0.0_best_int', `${l}.traineddata.gz`)),
}

/** Embeddings de prueba: bolsa de raíces de palabra (5 letras) en 128 dimensiones. Sin el prefijo de EmbeddingGemma. */
function fakeEmbedding(text: string): number[] {
  const body = text.replace(/^.*?\| (?:query|text): /s, '')
  const v = new Array(128).fill(0)
  for (const w of body.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) ?? []) {
    let h = 0
    for (const c of w.slice(0, 5)) h = (h * 31 + c.charCodeAt(0)) % 128
    v[h] += 1
  }
  return v
}

/** Ollama simulado en 127.0.0.1 (solo /api/embed), para usar el cliente real y ver por dónde salen las peticiones. */
let server: Server
let host = ''
let embedCalls = 0
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/api/embed') {
        embedCalls++
        const b = JSON.parse(body) as { input: string[] }
        res.end(JSON.stringify({ embeddings: b.input.map(fakeEmbedding) }))
      } else res.writeHead(404).end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zh-kb-')))
  const db = openDatabase(join(dir, 'z.db'))
  migrate(db)
  const attachments = new AttachmentService({ repo: new AttachmentsRepo(db), root: join(dir, 'att'), ocrDir: join(dir, 'ocr'), workerPath: null, assets: ASSETS, ollama: () => new OllamaClient(host), emit: () => {} })
  const progress: string[] = []
  const knowledge = new KnowledgeService({
    repo: new KnowledgeRepo(db),
    ollama: () => new OllamaClient(host),
    embedModel: () => 'embeddinggemma',
    extract: (file, ext, d) => attachments.extractText(file, ext, d),
    workDir: join(dir, 'kb-tmp'),
    folderProblem: (abs) => (abs.includes('sensible') ? 'Es una carpeta del sistema.' : null),
    emit: (p) => progress.push(p.phase),
    watch: false,
  })
  const sent: HostRequest[] = []
  const listeners: ((e: HostEvent) => void)[] = []
  const hostBridge = { send: (m: HostRequest) => sent.push(m), onEvent: (l: (e: HostEvent) => void) => listeners.push(l), onExit: () => {} }
  const events: { type: string; sources?: unknown[] }[] = []
  const assistant = new AssistantService({ repo: new AssistantRepo(db), knowledge, settings: new SettingsRepo(db), host: hostBridge as never, attachments, emit: (e) => events.push(e), now: () => new Date(2026, 10, 24) })
  const reply = (taskId: string, text: string) => listeners.forEach((l) => l({ type: 'chat.done', taskId, text, metrics: { promptTokens: 1, evalTokens: 1, loadMs: 0, promptMs: 1, evalMs: 1, totalMs: 2, tokensPerSec: 1, prefillTokensPerSec: 1 } } as HostEvent))
  const docs = join(dir, 'documentos')
  mkdirSync(join(docs, 'procedimientos'), { recursive: true })
  return { dir, db, docs, knowledge, assistant, sent, events, reply, progress }
}

async function until(cond: () => boolean, ms = 5000) {
  const t = Date.now()
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('tiempo agotado')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('troceado y búsqueda (funciones puras)', () => {
  it('trocea por páginas de PDF y hojas de Excel, con solape y sin cortar a mitad de palabra', () => {
    const text = `--- Página 1 ---\n${'Primera página. '.repeat(10)}\n--- Página 2 ---\n${'Frase de la segunda página con datos. '.repeat(80)}\n\n## Hoja «Tarifas» (3 filas × 2 columnas)\nproducto,precio\nqueso,10`
    const chunks = chunkText(text)
    expect(chunks[0]).toMatchObject({ page: 1, section: null })
    expect(chunks.filter((c) => c.page === 2).length).toBeGreaterThan(1)
    expect(chunks.at(-1)).toMatchObject({ section: 'Hoja Tarifas', page: null })
    expect(chunks.every((c) => c.text.length <= 1200)).toBe(true)
    const p2 = chunks.filter((c) => c.page === 2)
    expect(p2[1]!.text.startsWith('Frase') || p2[1]!.text.startsWith('de') || /^[A-Za-zá-ú]/.test(p2[1]!.text)).toBe(true)
    expect(chunkText('')).toEqual([])
  })

  it('consulta por palabras: sin palabras vacías, en prefijo y sin plurales; los números exactos', () => {
    expect(ftsQuery('¿Cuántos días tenemos para pagar a los proveedores?')).toBe('"dias"* OR "pagar"* OR "proveedor"*')
    expect(ftsQuery('cargo 338079')).toBe('"cargo"* OR "338079"')
    expect(ftsQuery('¿y?')).toBeNull()
  })

  it('vectores normalizados y fusión de rankings', () => {
    const a = fromBlob(toBlob([3, 4]))
    expect(dot(a, a)).toBeCloseTo(1, 5)
    const fused = fuseRankings([[1, 2, 3], [3, 4]])
    expect(fused[0]!.id).toBe(3) // aparece en las dos listas
    expect(fused.map((f) => f.id).sort()).toEqual([1, 2, 3, 4])
  })

  it('citas y comprobación de la respuesta', () => {
    expect(citedNumbers('El plazo es 60 días [2] y el descuento [1, 3].')).toEqual([1, 2, 3])
    const src = [{ n: 1 }, { n: 2 }] as AssistantSource[]
    expect(checkAnswer('Son 60 días [2].', src)).toBeNull()
    expect(checkAnswer('Son 60 días [5].', src)).toMatch(/\[5\].*no corresponde/)
    expect(checkAnswer('Son 60 días.', src)).toMatch(/sin citar/)
    expect(checkAnswer(`${NOT_FOUND_PHRASE}.`, src)).toBeNull()
    expect(checkAnswer('Hola', [])).toBeNull()
    expect(sourcesBlock([])).toContain(NOT_FOUND_PHRASE)
  })
})

describe('bases de conocimiento', () => {
  it('indexa PDF, Word, Excel y texto de las carpetas elegidas, sin seguir enlaces ni leer ocultos', async () => {
    const { docs, knowledge, dir } = setup()
    writeFileSync(join(docs, 'procedimientos', 'pagos.docx'), makeDocx(['Procedimiento de pagos.', 'El plazo de pago a proveedores nacionales es de 60 días desde la fecha de factura.']))
    writeFileSync(join(docs, 'tarifas.xlsx'), makeXlsx([{ name: 'Quesos', rows: [['Producto', 'Precio'], ['Manchego curado', 12.5]] }]))
    writeFileSync(join(docs, 'vacaciones.pdf'), makeTextPdf(['Calendario laboral.', 'Las vacaciones de verano se solicitan antes del 31 de marzo.']))
    writeFileSync(join(docs, 'notas.txt'), 'El código del cliente ALCAMPO en SAP es 400123.')
    writeFileSync(join(docs, '.oculto.txt'), 'secreto')
    writeFileSync(join(docs, '~$temporal.docx'), 'x')
    writeFileSync(join(docs, 'programa.exe'), 'MZ')
    const fuera = join(dir, 'fuera')
    mkdirSync(fuera)
    writeFileSync(join(fuera, 'privado.txt'), 'no debe entrar')
    symlinkSync(fuera, join(docs, 'atajo'))

    expect((await listFiles(docs)).map((f) => f.rel)).toEqual(['notas.txt', 'procedimientos/pagos.docx', 'tarifas.xlsx', 'vacaciones.pdf'])

    const [col] = knowledge.create('Empresa', false)
    knowledge.addFolder(col!.id, docs)
    await knowledge.idle()
    const list = knowledge.documents(col!.id)
    expect(list.map((d) => [d.relPath, d.status])).toEqual([
      ['notas.txt', 'indexed'],
      ['procedimientos/pagos.docx', 'indexed'],
      ['tarifas.xlsx', 'indexed'],
      ['vacaciones.pdf', 'indexed'],
    ])
    expect(list.find((d) => d.name === 'vacaciones.pdf')!.pages).toBe(2)
    expect(knowledge.get(col!.id)).toMatchObject({ documents: 4, errors: 0, indexing: null })

    const r = await knowledge.search([col!.id], '¿Cuántos días de plazo tenemos para pagar a los proveedores?')
    expect(r[0]).toMatchObject({ n: 1, name: 'pagos.docx', relPath: 'procedimientos/pagos.docx' })
    const sap = await knowledge.search([col!.id], 'código SAP de ALCAMPO')
    expect(sap[0]!.name).toBe('notas.txt')
    const pdf = await knowledge.search([col!.id], 'cuándo se piden las vacaciones de verano')
    expect(pdf[0]).toMatchObject({ name: 'vacaciones.pdf', page: 2 })
    expect(await knowledge.search([], 'plazo')).toEqual([])
  }, 60_000)

  it('se pone al día: documentos cambiados, borrados y nuevos; sin volver a leer los que no cambian', async () => {
    const { docs, knowledge } = setup()
    writeFileSync(join(docs, 'a.txt'), 'Horario de oficina de 8 a 15 horas.')
    writeFileSync(join(docs, 'b.txt'), 'El almacén cierra los sábados.')
    const [col] = knowledge.create('Oficina', false)
    knowledge.addFolder(col!.id, docs)
    await knowledge.idle()
    const before = embedCalls
    knowledge.reindex(col!.id)
    await knowledge.idle()
    expect(embedCalls).toBe(before) // nada cambió: no se recalcula

    writeFileSync(join(docs, 'a.txt'), 'Horario de oficina de 9 a 17 horas.')
    utimesSync(join(docs, 'a.txt'), new Date(), new Date(Date.now() + 5000))
    rmSync(join(docs, 'b.txt'))
    writeFileSync(join(docs, 'c.txt'), 'Las devoluciones se tramitan en 15 días.')
    knowledge.reindex(col!.id)
    await knowledge.idle()
    expect(knowledge.documents(col!.id).map((d) => d.relPath)).toEqual(['a.txt', 'c.txt'])
    const r = await knowledge.search([col!.id], 'horario de la oficina')
    expect(r[0]!.text).toContain('9 a 17')
    expect(r.some((s) => s.text.includes('8 a 15'))).toBe(false)
  })

  it('rechaza carpetas sensibles; un documento ilegible queda con su error; borrar la base borra su índice', async () => {
    const { docs, knowledge, db, dir } = setup()
    const [col] = knowledge.create('Mixta', false)
    expect(() => knowledge.addFolder(col!.id, join(dir, 'sensible'))).toThrow(/No se puede usar esta carpeta/)
    expect(() => knowledge.addFolder(col!.id, 'relativa')).toThrow(/absoluta/)
    writeFileSync(join(docs, 'roto.pdf'), 'esto no es un pdf')
    writeFileSync(join(docs, 'bien.txt'), 'Texto correcto.')
    knowledge.addFolder(col!.id, docs)
    await knowledge.idle()
    const roto = knowledge.documents(col!.id).find((d) => d.name === 'roto.pdf')!
    expect(roto.status).toBe('error')
    expect(roto.error).toMatch(/no corresponde/)
    expect(knowledge.get(col!.id)).toMatchObject({ documents: 1, errors: 1 })
    knowledge.delete(col!.id)
    for (const t of ['kb_documents', 'kb_chunks', 'kb_chunks_fts', 'kb_folders']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0)
    expect(knowledge.list()).toEqual([])
  })
})

describe('chat del asistente', () => {
  it('busca en las bases de la conversación, pasa los fragmentos numerados y guarda la respuesta con sus fuentes', async () => {
    const { docs, knowledge, assistant, sent, events, reply } = setup()
    writeFileSync(join(docs, 'pagos.txt'), 'El plazo de pago a proveedores nacionales es de 60 días desde la fecha de factura.')
    const [col] = knowledge.create('Empresa', false)
    knowledge.addFolder(col!.id, docs)
    await knowledge.idle()
    const conv = assistant.create({ collectionIds: [col!.id, 'no-existe'], private: false })
    expect(conv).toMatchObject({ private: false, collectionIds: [col!.id] })
    const r = await assistant.send({ conversationId: conv.id, text: '¿Cuál es el plazo de pago a proveedores?', model: 'gemma4:e4b-it-qat' })
    await until(() => sent.length > 0)
    const start = sent[0] as Extract<HostRequest, { type: 'chat.start' }>
    expect(start.type).toBe('chat.start')
    expect(start.messages[0]!.content).toMatch(/cita su número entre corchetes/)
    expect(start.messages[0]!.content).toContain('Empresa')
    const last = start.messages.at(-1)!
    expect(last.content).toContain('¿Cuál es el plazo de pago a proveedores?')
    expect(last.content).toContain('[1] pagos.txt')
    expect(last.content).toContain('60 días')
    expect(start.temperature).toBeLessThanOrEqual(0.3)
    expect(events.find((e) => e.type === 'sources')!.sources).toHaveLength(1)

    reply(r.taskId, 'El plazo es de 60 días desde la fecha de factura [1].')
    const msgs = assistant.messages(conv.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    const blocks = msgs[1]!.blocks as { kind: string; items?: { cited: boolean; name: string }[] }[]
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'sources'])
    expect(blocks[1]!.items![0]).toMatchObject({ name: 'pagos.txt', cited: true })
    expect(assistant.get(conv.id).title).toBe('¿Cuál es el plazo de pago a proveedores?')
  })

  it('sin bases conectadas no busca; si la respuesta cita fuentes inexistentes, se avisa', async () => {
    const { docs, knowledge, assistant, sent, reply } = setup()
    const plain = assistant.create({ collectionIds: [], private: false })
    await assistant.send({ conversationId: plain.id, text: 'Redacta un saludo', model: 'm' })
    await until(() => sent.length > 0)
    const s0 = sent[0] as Extract<HostRequest, { type: 'chat.start' }>
    expect(s0.messages.at(-1)!.content).toBe('Redacta un saludo')
    expect(s0.messages[0]!.content).toMatch(/no hay bases de conocimiento conectadas/)

    writeFileSync(join(docs, 'x.txt'), 'El descuento por pronto pago es del 2 %.')
    const [col] = knowledge.create('E', false)
    knowledge.addFolder(col!.id, docs)
    await knowledge.idle()
    const conv = assistant.create({ collectionIds: [col!.id], private: false })
    const r = await assistant.send({ conversationId: conv.id, text: 'descuento por pronto pago', model: 'm' })
    await until(() => sent.length > 1)
    reply(r.taskId, 'Es del 2 % [4].')
    const last = assistant.messages(conv.id).at(-1)!.blocks as { kind: string; text?: string }[]
    expect(last.find((b) => b.kind === 'notice')!.text).toMatch(/\[4\].*no corresponde/)
  })

  it('privadas y confidenciales: nada se guarda en disco', async () => {
    const { docs, knowledge, assistant, sent, reply, db } = setup()
    writeFileSync(join(docs, 'nominas.txt'), 'Las nóminas se pagan el día 28 de cada mes.')
    const [conf] = knowledge.create('RR. HH.', true)
    knowledge.addFolder(conf!.id, docs)
    await knowledge.idle()
    // Con una base confidencial la conversación es privada aunque no se pida
    const c = assistant.create({ collectionIds: [conf!.id], private: false })
    expect(c.private).toBe(true)
    const r = await assistant.send({ conversationId: c.id, text: '¿Qué día se pagan las nóminas?', model: 'm' })
    await until(() => sent.length > 0)
    reply(r.taskId, 'El día 28 de cada mes [1].')
    expect(assistant.messages(c.id)).toHaveLength(2)
    expect(assistant.list().map((x) => x.id)).toContain(c.id)
    for (const t of ['assistant_conversations', 'assistant_messages']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0)
    // Una conversación guardada no puede conectar una base confidencial
    const saved = assistant.create({ collectionIds: [], private: false })
    expect(() => assistant.update(saved.id, { collectionIds: [conf!.id] })).toThrow(/confidencial/)
    // Si una base pasa a confidencial, sus conversaciones guardadas dejan de poder usarla
    const [normal] = knowledge.create('General', false).filter((x) => x.name === 'General')
    const withNormal = assistant.create({ collectionIds: [normal!.id], private: false })
    knowledge.update(normal!.id, { confidential: true })
    await expect(assistant.send({ conversationId: withNormal.id, text: 'hola', model: 'm' })).rejects.toThrow(/confidencial/)
    assistant.delete(c.id)
    expect(assistant.list().map((x) => x.id)).not.toContain(c.id)
  })

  it('todo el tráfico de la indexación y la búsqueda va al Ollama de este equipo (127.0.0.1)', async () => {
    const hosts = new Set<string>()
    const onReq = ({ request }: { request: { origin: string } }) => hosts.add(new URL(request.origin).hostname)
    diagnostics.subscribe('undici:request:create', onReq as never)
    try {
      const { docs, knowledge } = setup()
      writeFileSync(join(docs, 'a.txt'), 'Política de devoluciones: 15 días.')
      const [col] = knowledge.create('Red', false)
      knowledge.addFolder(col!.id, docs)
      await knowledge.idle()
      await knowledge.search([col!.id], 'devoluciones')
    } finally {
      diagnostics.unsubscribe('undici:request:create', onReq as never)
    }
    expect([...hosts]).toEqual(['127.0.0.1'])
  })
})
