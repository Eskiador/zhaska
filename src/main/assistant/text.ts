/**
 * Troceado del texto de los documentos y búsqueda combinada (Fase 12). Funciones puras, probadas aparte.
 * El texto llega del extractor de adjuntos (Fase 8): los PDF traen «--- Página N ---» y los Excel «## Hoja «X»».
 */

export interface Chunk {
  ord: number
  page: number | null
  section: string | null
  text: string
}

/** Tamaño de cada fragmento (caracteres): cabe una idea completa y la búsqueda sigue siendo precisa. */
export const CHUNK_CHARS = 1200
const OVERLAP = 200

export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): Chunk[] {
  const size = opts.size ?? CHUNK_CHARS
  const overlap = opts.overlap ?? OVERLAP
  // 1. Secciones naturales: páginas de PDF y hojas de Excel
  const sections: { page: number | null; section: string | null; text: string }[] = []
  const marker = /^(?:--- Página (\d+) ---|## Hoja «(.+?)».*)$/gm
  let last = 0
  let cur: { page: number | null; section: string | null } = { page: null, section: null }
  for (const m of text.matchAll(marker)) {
    sections.push({ ...cur, text: text.slice(last, m.index) })
    cur = m[1] ? { page: Number(m[1]), section: null } : { page: null, section: `Hoja ${m[2]}` }
    last = m.index! + m[0].length
  }
  sections.push({ ...cur, text: text.slice(last) })

  // 2. Dentro de cada sección, trozos de ~size caracteres cortados en párrafos o frases, con solape
  const out: Chunk[] = []
  for (const s of sections) {
    const body = s.text.replace(/\n{3,}/g, '\n\n').trim()
    if (!body) continue
    let start = 0
    while (start < body.length) {
      let end = Math.min(body.length, start + size)
      if (end < body.length) {
        const window = body.slice(start + Math.floor(size * 0.5), end)
        const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. '))
        if (cut > 0) end = start + Math.floor(size * 0.5) + cut + 1
      }
      const piece = body.slice(start, end).trim()
      if (piece) out.push({ ord: out.length, page: s.page, section: s.section, text: piece })
      if (end >= body.length) break
      start = Math.max(end - overlap, start + 1)
    }
  }
  return out
}

const STOPWORDS = new Set(
  'de la el los las un una unos unas y o u a en con por para del al que se su sus es son lo le les nos me te mi tu como cual cuales cuál cuáles qué que quien quién cuando cuándo donde dónde cuanto cuánto cuantos cuántos cuánta cuántas hay tiene tienen tenemos dice dicen sobre mis tus este esta estos estas ese esa eso entre pero más mas muy ya no si sí ser está están fue han ha'.split(
    ' ',
  ),
)

/** Consulta FTS5 a partir de la pregunta: palabras con significado, en forma de prefijo y sin plurales. */
export function ftsQuery(question: string): string | null {
  const words = question
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .match(/[\p{L}\p{N}]+/gu)
  if (!words) return null
  const terms = new Set<string>()
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w)) continue
    const stem = /^\d+$/.test(w) ? w : w.length > 5 && w.endsWith('es') ? w.slice(0, -2) : w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w
    terms.add(/^\d+$/.test(stem) ? `"${stem}"` : `"${stem}"*`)
  }
  return terms.size ? [...terms].join(' OR ') : null
}

export function toBlob(v: number[] | Float32Array): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v)
  let norm = 0
  for (const x of f) norm += x * x
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(f.length)
  for (let i = 0; i < f.length; i++) out[i] = f[i]! / norm
  return new Uint8Array(out.buffer)
}

export function fromBlob(b: Uint8Array): Float32Array {
  // Copia alineada: el búfer de SQLite puede no estar alineado a 4 bytes
  return new Float32Array(b.slice().buffer, 0, b.byteLength / 4)
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/**
 * Fusión de rankings (Reciprocal Rank Fusion): combina la búsqueda por palabras y la de significado sin tener
 * que comparar sus puntuaciones, que están en escalas distintas.
 */
export function fuseRankings(lists: number[][], k = 60): { id: number; score: number }[] {
  const score = new Map<number, number>()
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)))
  return [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score)
}

/** Textos para EmbeddingGemma: pide prefijos distintos para preguntas y documentos. */
export const embedQuery = (q: string) => `task: search result | query: ${q}`
export const embedDocument = (title: string, text: string) => `title: ${title || 'none'} | text: ${text}`
