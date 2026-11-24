/**
 * Adjuntos (Fase 8, ARCHITECTURE §8): tipos, formatos admitidos y límites compartidos por main, Agent Host y UI.
 * Los adjuntos son contexto de solo lectura: viven fuera del proyecto y el agente solo puede leerlos.
 */

export type AttachmentKind = 'pdf' | 'doc' | 'sheet' | 'image' | 'code' | 'archive' | 'text' | 'other'
export type AttachmentStatus = 'processing' | 'ready' | 'error'

export const ATTACHMENT_LIMITS = {
  /** Tamaño máximo de cada archivo */
  fileBytes: 50 * 1024 * 1024,
  /** Adjuntos por mensaje */
  perMessage: 20,
  /** ZIP: tamaño total descomprimido, número de entradas y ratio de compresión sospechoso */
  zipTotalBytes: 200 * 1024 * 1024,
  zipEntries: 10_000,
  zipRatio: 100,
  /** Páginas de un PDF escaneado que se pasan por OCR */
  ocrPages: 30,
} as const

/** Extensiones admitidas → tipo. Cualquier otra se admite solo si su contenido es texto. */
export const EXT_KIND: Record<string, AttachmentKind> = {
  pdf: 'pdf',
  docx: 'doc',
  txt: 'text', md: 'text', markdown: 'text', log: 'text', rst: 'text',
  xlsx: 'sheet', csv: 'sheet', tsv: 'sheet',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image',
  zip: 'archive',
  html: 'code', htm: 'code', css: 'code', scss: 'code', less: 'code', js: 'code', mjs: 'code', cjs: 'code', jsx: 'code', ts: 'code', tsx: 'code', mts: 'code', cts: 'code',
  py: 'code', json: 'code', jsonc: 'code', sql: 'code', xml: 'code', yml: 'code', yaml: 'code', toml: 'code', ini: 'code', cfg: 'code', conf: 'code', env: 'code',
  sh: 'code', bash: 'code', ps1: 'code', bat: 'code', cmd: 'code', java: 'code', kt: 'code', c: 'code', h: 'code', cpp: 'code', hpp: 'code', cs: 'code', go: 'code', rs: 'code',
  rb: 'code', php: 'code', swift: 'code', vue: 'code', svelte: 'code', astro: 'code', graphql: 'code', gql: 'code', prisma: 'code', dockerfile: 'code', gradle: 'code', lua: 'code', r: 'code', dart: 'code',
}

/** Formatos binarios que se rechazan con un motivo claro (no se pueden analizar de forma segura o fiable). */
export const UNSUPPORTED: Record<string, string> = {
  doc: 'Formato .doc antiguo: guárdalo como .docx o PDF.',
  xls: 'Formato .xls antiguo: guárdalo como .xlsx o CSV.',
  ppt: 'Las presentaciones aún no se pueden analizar: expórtala a PDF.',
  pptx: 'Las presentaciones aún no se pueden analizar: expórtala a PDF.',
  rar: 'Solo se admiten archivos comprimidos .zip.',
  '7z': 'Solo se admiten archivos comprimidos .zip.',
  exe: 'Los ejecutables no se adjuntan por seguridad.',
  msi: 'Los instaladores no se adjuntan por seguridad.',
  dll: 'Las bibliotecas binarias no se adjuntan por seguridad.',
}

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  if (/^dockerfile$/i.test(base)) return 'dockerfile'
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

export function kindOfExt(ext: string): AttachmentKind {
  return EXT_KIND[ext] ?? 'other'
}

/** Metadatos que produce la extracción (se guardan en meta_json). */
export interface AttachmentMetaInfo {
  /** Caracteres del texto extraído */
  chars?: number
  pages?: number
  sheets?: { name: string; rows: number; cols: number }[]
  /** Páginas o imagen leídas con OCR y confianza media (0-100) */
  ocr?: { pages: number; confidence: number }
  width?: number
  height?: number
  encoding?: string
  /** ZIP: entradas extraídas y rechazadas */
  entries?: number
  rejected?: number
  hasThumb?: boolean
  hasVision?: boolean
  warnings?: string[]
}

/** Nombre seguro para mostrar y para el modelo (sin rutas, controles ni longitud excesiva). */
export function safeDisplayName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (base || 'archivo').slice(0, 180)
}
