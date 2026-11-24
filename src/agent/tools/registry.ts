import { readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ToolName } from '@shared/agent/events'
import type { PathGuard } from '@core/security/pathGuard'
import type { OutsideReads } from '@core/security/outsideReads'
import { AppError } from '@core/errors'
import { assessCommand, type CommandAssessment } from '@core/security/commandPolicy'
import { protectedHit } from '@shared/protectedFiles'
import { clip, type RunResult } from '@core/commands/runner'
import { IGNORED_DIRS } from '@core/workspace/fileService'
import { applyEdits, EditError } from '../workspace/edit'
import { detectProject, parseDiagnostics, projectTree, searchCode } from '../workspace/explore'
import type { ChangeTracker } from '../workspace/changes'
import type { AttachmentRef } from '@shared/agent/host'

export type PermissionAction = 'read' | 'write' | 'execute' | 'install' | 'internet'

/** Lo que una llamada necesita para ejecutarse; el bucle lo cruza con los ajustes del usuario. */
export interface PermissionNeed {
  action: PermissionAction
  /** Texto para la tarjeta de aprobación */
  detail: string
  command?: string
  assessment?: CommandAssessment
  /** Lectura o escritura de un archivo protegido (.env, claves, .git…): siempre pregunta */
  protectedPath?: string
  /** Lectura fuera del proyecto sin carpeta autorizada: siempre pregunta (y se aprueba solo esa ruta) */
  outsidePath?: string
  /** Eliminar siempre pregunta, incluso en modo autónomo */
  alwaysAsk?: boolean
}

export interface ToolContext {
  root: string
  guard: PathGuard
  signal: AbortSignal
  changes: ChangeTracker
  output: (line: string) => void
  run: (spec: { command?: string; file?: string; args?: string[]; timeoutMs: number }) => Promise<RunResult>
  plan: (items: { id: string; title: string; tool?: ToolName; target?: string }[]) => void
  protectedPatterns: string[]
  /** Adjuntos legibles (solo lectura, fuera del proyecto) */
  attachments: AttachmentRef[]
  /** Lecturas fuera del proyecto: carpetas autorizadas y rutas aprobadas */
  outside: OutsideReads
}

export interface ToolResult {
  ok: boolean
  /** Texto que recibe el modelo */
  output: string
  /** Resumen corto para el panel de actividad */
  summary?: string
  diff?: { additions: number; deletions: number }
}

export interface ToolDef<A = unknown> {
  name: ToolName
  description: string
  schema: z.ZodType<A>
  /** Título y objetivo para el panel de actividad */
  describe: (args: A) => { title: string; target?: string }
  permission: (args: A, ctx: ToolContext) => PermissionNeed
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult>
}

const MAX_READ_LINES = 400
/** write_file solo reescribe archivos pequeños: en los grandes, el modelo podría dejarse partes (Fase 11) */
const MAX_REWRITE_LINES = 400
const ATTACHMENT_CHUNK = 10_000

/** Busca un adjunto por id, nombre exacto o nombre sin distinguir mayúsculas. */
export function findAttachment(list: AttachmentRef[], name: string): AttachmentRef | undefined {
  const n = name.trim().replace(/^@/, '')
  return list.find((a) => a.id === n) ?? list.find((a) => a.name === n) ?? list.find((a) => a.name.toLowerCase() === n.toLowerCase())
}
const P = z.string().min(1).describe('Ruta relativa a la raíz del proyecto, con "/"')

const define = <A>(t: ToolDef<A>) => t as unknown as ToolDef<unknown>

/**
 * Destino de una lectura: rutas relativas (o absolutas dentro del proyecto) → proyecto; absolutas fuera →
 * carpeta autorizada o ruta aprobada por el usuario (OutsideReads).
 */
function readTarget(ctx: ToolContext, p: string): { guard: PathGuard; rel: string; outside: boolean } {
  if (!ctx.outside.isAbsolute(p)) return { guard: ctx.guard, rel: p === '.' ? '' : p, outside: false }
  const inProject = ctx.guard.toRel(p)
  if (inProject !== null) return { guard: ctx.guard, rel: inProject, outside: false }
  return { ...ctx.outside.resolve(p), outside: true }
}

/** Permiso de una lectura: protegido → pregunta; fuera del proyecto sin autorizar → pregunta con aviso. */
function readNeed(ctx: ToolContext, p: string, detail: string): PermissionNeed {
  if (ctx.outside.isAbsolute(p) && ctx.guard.toRel(p) === null) {
    ctx.outside.check(p) // bloqueadas, red, inexistentes → error
    const hit = ctx.outside.locate(p)
    if (hit) return { action: 'read', detail: `${detail} (carpeta autorizada, solo lectura)`, protectedPath: protectedHit(hit.rel, ctx.protectedPatterns) }
    return { action: 'read', detail: `${detail} · fuera del proyecto (solo lectura)`, outsidePath: p }
  }
  const rel = ctx.outside.isAbsolute(p) ? (ctx.guard.toRel(p) ?? '') : ctx.guard.normalizeRel(p === '.' ? '' : p)
  return { action: 'read', detail, protectedPath: rel ? protectedHit(rel, ctx.protectedPatterns) : undefined }
}

/** Las herramientas de archivos solo modifican el proyecto (acepta rutas absolutas que estén dentro). */
function writeRel(ctx: ToolContext, p: string): string {
  if (ctx.outside.isAbsolute(p)) {
    const rel = ctx.guard.toRel(p)
    if (rel === null) throw new AppError('FORBIDDEN_PATH', `Solo se pueden modificar archivos dentro del proyecto: ${p}. Fuera de él el agente solo puede leer, y con permiso del usuario.`)
    return rel
  }
  return ctx.guard.normalizeRel(p)
}

const writeNeed = (ctx: ToolContext, p: string, detail: string, alwaysAsk = false): PermissionNeed => {
  const rel = writeRel(ctx, p)
  return { action: 'write', detail, alwaysAsk, protectedPath: protectedHit(rel, ctx.protectedPatterns) }
}

/** Scripts de package.json para que CommandPolicy juzgue lo que de verdad ejecuta `npm run x`. */
function npmScripts(root: string): (name: string) => string | null {
  let scripts: Record<string, unknown> | null = null
  return (name) => {
    if (scripts === null) {
      try {
        scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {}
      } catch {
        scripts = {}
      }
    }
    const v = scripts[name]
    return typeof v === 'string' ? v : null
  }
}

async function writeTracked(ctx: ToolContext, rel: string, content: string | null) {
  const clean = writeRel(ctx, rel)
  const abs = ctx.guard.resolve(clean)
  await ctx.changes.beforeWrite(clean, abs)
  if (content === null) await rm(abs, { force: true })
  else {
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
  return ctx.changes.afterWrite(clean, content === null ? null : Buffer.from(content, 'utf8'))
}

function fsError(e: unknown, rel: string): ToolResult {
  const code = (e as NodeJS.ErrnoException)?.code
  const msg = code === 'ENOENT' ? `No existe: ${rel}` : code === 'EISDIR' ? `${rel} es una carpeta` : (e as Error)?.message ?? String(e)
  return { ok: false, output: `Error: ${msg}` }
}

function commandResult(r: RunResult, label: string): ToolResult {
  const status = r.cancelled ? 'cancelado' : r.timedOut ? 'tiempo agotado' : `código de salida ${r.exitCode}`
  const ok = !r.cancelled && !r.timedOut && r.exitCode === 0
  return { ok, output: `$ ${label}\n(${status}, ${(r.durationMs / 1000).toFixed(1)} s)\n${clip(r.output.trim() || '(sin salida)')}`, summary: status }
}

export const TOOLS: ToolDef[] = [
  define({
    name: 'get_project_structure',
    description: 'Muestra el árbol de carpetas y archivos del proyecto (omite node_modules, .git, dist…). Úsalo primero para orientarte.',
    schema: z.object({ path: z.string().default('.'), depth: z.number().int().min(1).max(6).default(3) }),
    describe: (a) => ({ title: 'Estructura del proyecto', target: a.path === '.' ? undefined : a.path }),
    permission: (a, ctx) => (a.path === '.' ? { action: 'read', detail: 'Ver la estructura del proyecto' } : readNeed(ctx, a.path, `Ver la estructura de ${a.path}`)),
    execute: async (a, ctx) => {
      const t = readTarget(ctx, a.path)
      const tree = await projectTree(t.guard, t.rel, a.depth)
      return { ok: true, output: tree, summary: `${tree.split('\n').length} entradas` }
    },
  }),
  define({
    name: 'list_files',
    description: 'Lista el contenido de una carpeta concreta con tamaños.',
    schema: z.object({ path: z.string().default('.') }),
    describe: (a) => ({ title: 'Listar carpeta', target: a.path }),
    permission: (a, ctx) => readNeed(ctx, a.path, `Listar ${a.path}`),
    execute: async (a, ctx) => {
      try {
        const { guard, rel } = readTarget(ctx, a.path)
        const entries = await readdir(guard.resolve(rel), { withFileTypes: true })
        const lines = await Promise.all(
          entries
            .filter((d) => !['.DS_Store', 'Thumbs.db'].includes(d.name))
            .sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1))
            .map(async (d) => {
              if (d.isDirectory()) return `${d.name}/${IGNORED_DIRS.has(d.name) ? ' (dependencias/compilado)' : ''}`
              const st = await stat(guard.resolve(rel ? `${rel}/${d.name}` : d.name)).catch(() => null)
              return `${d.name}${st ? ` (${st.size} B)` : ''}`
            }),
        )
        return { ok: true, output: lines.join('\n') || '(carpeta vacía)', summary: `${lines.length} elementos` }
      } catch (e) {
        return fsError(e, a.path)
      }
    },
  }),
  define({
    name: 'read_file',
    description: `Lee un archivo de texto con números de línea (máx. ${MAX_READ_LINES} líneas por llamada; usa offset para seguir).`,
    schema: z.object({ path: P, offset: z.number().int().min(1).default(1).describe('Primera línea (empieza en 1)'), limit: z.number().int().min(1).max(MAX_READ_LINES).default(MAX_READ_LINES) }),
    describe: (a) => ({ title: 'Leer archivo', target: a.path }),
    permission: (a, ctx) => readNeed(ctx, a.path, `Leer ${a.path}`),
    execute: async (a, ctx) => {
      try {
        const t = readTarget(ctx, a.path)
        const abs = t.guard.resolve(t.rel)
        const st = await stat(abs)
        if (st.isDirectory()) return { ok: false, output: `Error: ${a.path} es una carpeta. Usa list_files.` }
        if (st.size > 2_000_000) return { ok: false, output: `Error: ${a.path} es demasiado grande (${st.size} B).` }
        const buf = await readFile(abs)
        if (buf.subarray(0, 8000).includes(0)) return { ok: false, output: `Error: ${a.path} es un archivo binario.` }
        const lines = buf.toString('utf8').split(/\r?\n/)
        const from = a.offset - 1
        const slice = lines.slice(from, from + a.limit)
        const body = slice.map((l, i) => `${String(from + i + 1).padStart(4)}│ ${l}`).join('\n')
        const more = from + a.limit < lines.length ? `\n… quedan ${lines.length - from - a.limit} líneas (usa offset=${from + a.limit + 1})` : ''
        return { ok: true, output: (body || '(archivo vacío)') + more, summary: `${lines.length} líneas` }
      } catch (e) {
        return fsError(e, a.path)
      }
    },
  }),
  define({
    name: 'search_code',
    description: 'Busca texto (o una expresión regular) en los archivos del proyecto. Devuelve archivo:línea: texto.',
    schema: z.object({ query: z.string().min(1), regex: z.boolean().default(false), glob: z.string().optional().describe('Filtrar archivos, p. ej. "*.tsx" o "src/**/*.ts"'), case_sensitive: z.boolean().default(false) }),
    describe: (a) => ({ title: 'Buscar en el código', target: a.query }),
    permission: (a) => ({ action: 'read', detail: `Buscar «${a.query}»` }),
    execute: async (a, ctx) => {
      try {
        const r = await searchCode(ctx.guard, a.query, { regex: a.regex, glob: a.glob, caseSensitive: a.case_sensitive, maxResults: 80, exclude: (rel) => !!protectedHit(rel, ctx.protectedPatterns) })
        const out = r.hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n')
        const skipped = r.excluded ? `\n(${r.excluded} archivo${r.excluded === 1 ? '' : 's'} protegido${r.excluded === 1 ? '' : 's'} sin revisar; léelos con read_file si hace falta, con permiso del usuario)` : ''
        return { ok: true, output: (out ? out + (r.truncated ? '\n… (resultados recortados; afina la búsqueda)' : '') : `Sin resultados (${r.filesScanned} archivos revisados).`) + skipped, summary: `${r.hits.length} coincidencias` }
      } catch (e) {
        return { ok: false, output: `Error en la búsqueda: ${(e as Error).message}` }
      }
    },
  }),
  define({
    name: 'read_attachment',
    description: 'Lee el contenido extraído de un adjunto del usuario (PDF, Word, Excel, CSV, texto, imagen con OCR o ZIP). Solo lectura: los adjuntos NO forman parte del proyecto. Usa offset para seguir leyendo; en un ZIP, path lee un archivo de dentro.',
    schema: z.object({
      name: z.string().min(1).describe('Nombre (o id) del adjunto'),
      offset: z.number().int().min(0).default(0).describe('Carácter desde el que leer'),
      path: z.string().optional().describe('Solo ZIP: ruta de un archivo dentro del ZIP'),
    }),
    describe: (a) => ({ title: 'Leer adjunto', target: a.path ? `${a.name} › ${a.path}` : a.name }),
    permission: (a) => ({ action: 'read', detail: `Leer el adjunto ${a.name}` }),
    execute: async (a, ctx) => {
      const att = findAttachment(ctx.attachments, a.name)
      if (!att) return { ok: false, output: `Error: no hay ningún adjunto llamado "${a.name}". Adjuntos disponibles: ${ctx.attachments.map((x) => x.name).join(', ') || '(ninguno)'}.` }
      let text: string
      let label = att.name
      try {
        if (a.path) {
          if (!att.unzipDir) return { ok: false, output: `Error: ${att.name} no es un ZIP; lee su contenido sin "path".` }
          const rel = a.path.replace(/\\/g, '/').replace(/^\/+/, '')
          const abs = path.resolve(att.unzipDir, rel)
          const inside = path.relative(att.unzipDir, abs)
          if (inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, output: 'Error: esa ruta está fuera del ZIP.' }
          const st = await stat(abs)
          if (st.isDirectory()) {
            const items = await readdir(abs, { withFileTypes: true })
            return { ok: true, output: items.map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).join('\n') || '(carpeta vacía)', summary: `${items.length} entradas` }
          }
          if (st.size > 2_000_000) return { ok: false, output: `Error: ${rel} es demasiado grande para leerlo (${st.size} B).` }
          const buf = await readFile(abs)
          if (buf.subarray(0, 8000).includes(0)) return { ok: false, output: `Error: ${rel} es un archivo binario.` }
          text = buf.toString('utf8')
          label = `${att.name} › ${rel}`
        } else text = await readFile(att.textFile, 'utf8')
      } catch {
        return { ok: false, output: `Error: no se encontró "${a.path ?? att.name}" en el adjunto.` }
      }
      const end = Math.min(text.length, a.offset + ATTACHMENT_CHUNK)
      const more = end < text.length ? `\n… quedan ${text.length - end} caracteres (usa offset=${end})` : ''
      return { ok: true, output: `Adjunto ${label} · caracteres ${a.offset}–${end} de ${text.length}\n${text.slice(a.offset, end) || '(sin texto)'}${more}`, summary: `${end - a.offset} caracteres` }
    },
  }),
  define({
    name: 'read_project_config',
    description: 'Resume la configuración del proyecto: package.json (scripts y dependencias), TypeScript, Python, gestor de paquetes y comandos de prueba.',
    schema: z.object({}),
    describe: () => ({ title: 'Leer configuración del proyecto' }),
    permission: () => ({ action: 'read', detail: 'Leer la configuración del proyecto' }),
    execute: async (_a, ctx) => {
      const info = await detectProject(ctx.root)
      return { ok: true, output: info.summary, summary: info.kind.join(', ') || 'sin configuración' }
    },
  }),
  define({
    name: 'update_plan',
    description: 'Declara o actualiza tu plan de trabajo (pasos concretos). Úsalo antes de una tarea de varios pasos.',
    schema: z.object({ steps: z.array(z.object({ title: z.string().min(1), tool: z.string().optional(), target: z.string().optional() })).min(1).max(20) }),
    describe: (a) => ({ title: 'Plan de trabajo', target: `${a.steps.length} pasos` }),
    permission: () => ({ action: 'read', detail: 'Actualizar el plan' }),
    execute: async (a, ctx) => {
      const known = new Set(TOOLS.map((t) => t.name))
      ctx.plan(a.steps.map((s, i) => ({ id: `p${i + 1}`, title: s.title, tool: s.tool && known.has(s.tool as ToolName) ? (s.tool as ToolName) : undefined, target: s.target })))
      return { ok: true, output: 'Plan registrado. Continúa con el primer paso.', summary: `${a.steps.length} pasos` }
    },
  }),
  define({
    name: 'create_file',
    description: 'Crea un archivo nuevo con el contenido indicado (crea las carpetas necesarias). Falla si ya existe: para cambiar archivos existentes usa edit_file.',
    schema: z.object({ path: P, content: z.string() }),
    describe: (a) => ({ title: 'Crear archivo', target: a.path }),
    permission: (a, ctx) => writeNeed(ctx, a.path, `Crear ${a.path}`),
    execute: async (a, ctx) => {
      if (existsSync(ctx.guard.resolve(writeRel(ctx, a.path)))) return { ok: false, output: `Error: ${a.path} ya existe. Usa edit_file para modificarlo.` }
      const c = await writeTracked(ctx, a.path, a.content)
      return { ok: true, output: `Creado ${a.path} (${c.additions} líneas).`, diff: { additions: c.additions, deletions: 0 } }
    },
  }),
  define({
    name: 'edit_file',
    description:
      'Modifica un archivo sustituyendo fragmentos exactos. Cada old_string debe copiarse literalmente del archivo (con su indentación, sin los números de línea) y aparecer una sola vez. Para AÑADIR texto al final del archivo, usa old_string vacío (""). Lee el archivo antes.',
    schema: z.object({
      path: P,
      edits: z.array(z.object({ old_string: z.string(), new_string: z.string() })).min(1).max(20),
      replace_all: z.boolean().default(false),
    }),
    describe: (a) => ({ title: 'Editar archivo', target: a.path }),
    permission: (a, ctx) => writeNeed(ctx, a.path, `Modificar ${a.path}`),
    execute: async (a, ctx) => {
      try {
        const before = await readFile(ctx.guard.resolve(writeRel(ctx, a.path)), 'utf8')
        const notes: string[] = []
        const after = applyEdits(before, a.edits, a.replace_all, notes)
        if (after === before) return { ok: true, output: `Sin cambios en ${a.path}: ${notes.join(' ') || 'las ediciones ya estaban aplicadas'}`, summary: 'ya aplicado' }
        const c = await writeTracked(ctx, a.path, after)
        return { ok: true, output: `Modificado ${a.path} (+${c.additions} −${c.deletions}).${notes.length ? `\n${notes.join('\n')}` : ''}`, diff: { additions: c.additions, deletions: c.deletions } }
      } catch (e) {
        if (e instanceof EditError) {
          // Se muestra en «Ver salida»: qué buscó el modelo (para entender por qué no coincidió)
          for (const ed of a.edits) ctx.output(`old_string buscado: ${JSON.stringify(ed.old_string).slice(0, 300)}`)
          return { ok: false, output: `Error: ${e.message}` }
        }
        return fsError(e, a.path)
      }
    },
  }),
  define({
    name: 'write_file',
    description: `Reescribe COMPLETO un archivo existente con el contenido indicado (archivos de hasta ${MAX_REWRITE_LINES} líneas). Útil cuando hay muchos cambios en un archivo pequeño. Para cambios puntuales usa edit_file; para archivos nuevos, create_file. Incluye todo el contenido: lo que no escribas se pierde.`,
    schema: z.object({ path: P, content: z.string() }),
    describe: (a) => ({ title: 'Reescribir archivo', target: a.path }),
    permission: (a, ctx) => writeNeed(ctx, a.path, `Reescribir ${a.path}`),
    execute: async (a, ctx) => {
      try {
        const abs = ctx.guard.resolve(writeRel(ctx, a.path))
        if (!existsSync(abs)) return { ok: false, output: `Error: ${a.path} no existe. Para archivos nuevos usa create_file.` }
        const before = await readFile(abs, 'utf8')
        const lines = before.split(/\r?\n/).length
        if (lines > MAX_REWRITE_LINES) return { ok: false, output: `Error: ${a.path} tiene ${lines} líneas; es demasiado grande para reescribirlo entero. Usa edit_file con fragmentos concretos.` }
        // Conserva los finales de línea del archivo (CRLF en Windows)
        const content = before.includes('\r\n') ? a.content.replace(/\r?\n/g, '\r\n') : a.content
        if (content === before) return { ok: false, output: 'Error: el contenido es idéntico al actual; no hay nada que cambiar.' }
        const c = await writeTracked(ctx, a.path, content)
        return { ok: true, output: `Reescrito ${a.path} (+${c.additions} −${c.deletions}).`, diff: { additions: c.additions, deletions: c.deletions } }
      } catch (e) {
        return fsError(e, a.path)
      }
    },
  }),
  define({
    name: 'delete_file',
    description: 'Elimina un archivo del proyecto (se guarda una copia para poder restaurarlo). No elimina carpetas.',
    schema: z.object({ path: P }),
    describe: (a) => ({ title: 'Eliminar archivo', target: a.path }),
    permission: (a, ctx) => writeNeed(ctx, a.path, `Eliminar ${a.path}`, true),
    execute: async (a, ctx) => {
      try {
        const st = await stat(ctx.guard.resolve(writeRel(ctx, a.path)))
        if (st.isDirectory()) return { ok: false, output: 'Error: delete_file no elimina carpetas.' }
        const c = await writeTracked(ctx, a.path, null)
        return { ok: true, output: `Eliminado ${a.path}.`, diff: { additions: 0, deletions: c.deletions } }
      } catch (e) {
        return fsError(e, a.path)
      }
    },
  }),
  define({
    name: 'execute_command',
    description: 'Ejecuta un comando de terminal en la raíz del proyecto y devuelve su salida. No uses comandos interactivos ni servidores que no terminan.',
    schema: z.object({ command: z.string().min(1).max(4000), timeout_seconds: z.number().int().min(5).max(600).default(120) }),
    describe: (a) => ({ title: 'Ejecutar comando', target: a.command }),
    permission: (a, ctx) => {
      const assessment = assessCommand(a.command, {
        isInsideProject: (abs) => ctx.guard.isInside(abs, ctx.root),
        npmScript: npmScripts(ctx.root),
        protectedHit: (rel) => protectedHit(rel, ctx.protectedPatterns),
      })
      return {
        action: assessment.network ? 'internet' : 'execute',
        detail: assessment.reasons.join(' · ') || 'Ejecutar en la raíz del proyecto',
        command: a.command,
        assessment,
        protectedPath: assessment.protectedPath,
        // Borrar con un comando no deja instantánea: se pregunta siempre, también en modo autónomo
        alwaysAsk: assessment.deletes,
      }
    },
    execute: async (a, ctx) => commandResult(await ctx.run({ command: a.command, timeoutMs: a.timeout_seconds * 1000 }), a.command),
  }),
  define({
    name: 'install_dependencies',
    description: 'Instala paquetes con el gestor del proyecto (npm, pnpm, yarn o pip). Sin "packages" instala lo que declara el proyecto.',
    schema: z.object({
      packages: z.array(z.string().regex(/^(@[\w.-]+\/)?[\w.-]+(@[\w.^~<>=*-]+)?$/, 'Nombre de paquete no válido')).max(30).default([]),
      dev: z.boolean().default(false),
    }),
    describe: (a) => ({ title: 'Instalar dependencias', target: a.packages.length ? a.packages.join(' ') : 'del proyecto' }),
    permission: (a) => ({ action: 'install', detail: `Instalar ${a.packages.length ? a.packages.join(', ') : 'las dependencias del proyecto'} (necesita Internet)` }),
    execute: async (a, ctx) => {
      const info = await detectProject(ctx.root)
      let file: string
      let args: string[]
      if (info.packageManager) {
        file = info.packageManager
        const verb = a.packages.length ? (info.packageManager === 'npm' ? 'install' : 'add') : 'install'
        args = [verb, ...a.packages, ...(a.dev && a.packages.length ? [info.packageManager === 'npm' ? '--save-dev' : '-D'] : [])]
      } else if (info.python) {
        file = 'python'
        args = a.packages.length ? ['-m', 'pip', 'install', ...a.packages] : existsSync(path.join(ctx.root, 'requirements.txt')) ? ['-m', 'pip', 'install', '-r', 'requirements.txt'] : ['-m', 'pip', 'install', '-e', '.']
      } else return { ok: false, output: 'Error: no se detectó package.json ni proyecto Python. Crea primero el archivo de configuración.' }
      return commandResult(await ctx.run({ file, args, timeoutMs: 600_000 }), `${file} ${args.join(' ')}`)
    },
  }),
  define({
    name: 'run_tests',
    description: 'Ejecuta las pruebas del proyecto con su comando habitual (npm test, pytest…).',
    schema: z.object({ filter: z.string().max(200).optional().describe('Patrón o archivo de prueba opcional') }),
    describe: (a) => ({ title: 'Ejecutar pruebas', target: a.filter }),
    permission: () => ({ action: 'execute', detail: 'Ejecutar las pruebas del proyecto', assessment: { level: 'safe', network: false, outsideProject: false, deletes: false, reasons: [] } }),
    execute: async (a, ctx) => {
      const info = await detectProject(ctx.root)
      if (!info.testCommand) return { ok: false, output: 'Este proyecto no tiene un comando de pruebas (falta el script "test" o pytest).' }
      const [file, ...args] = info.testCommand
      if (a.filter) args.push(...(file === 'python' ? [a.filter] : ['--', a.filter]))
      return commandResult(await ctx.run({ file: file!, args, timeoutMs: 600_000 }), [file, ...args].join(' '))
    },
  }),
  define({
    name: 'inspect_errors',
    description: 'Comprueba errores de compilación/tipos del proyecto (TypeScript con tsc, Python con compileall) y los devuelve estructurados.',
    schema: z.object({}),
    describe: () => ({ title: 'Comprobar errores' }),
    permission: () => ({ action: 'execute', detail: 'Comprobar tipos y errores', assessment: { level: 'safe', network: false, outsideProject: false, deletes: false, reasons: [] } }),
    execute: async (_a, ctx) => {
      const info = await detectProject(ctx.root)
      if (!info.typecheckCommand) return { ok: true, output: 'No hay comprobación de errores disponible para este proyecto (ni TypeScript ni Python).', summary: 'no aplicable' }
      const [file, ...args] = info.typecheckCommand
      const r = await ctx.run({ file: file!, args, timeoutMs: 300_000 })
      const diags = parseDiagnostics(r.output)
      if (r.exitCode === 0 && !diags.length) return { ok: true, output: `Sin errores (${[file, ...args].join(' ')}).`, summary: '0 errores' }
      const list = diags.map((d) => `${d.file}:${d.line} ${d.message}`).join('\n')
      return { ok: false, output: `${diags.length || 'Hay'} errores:\n${list || clip(r.output)}`, summary: `${diags.length} errores` }
    },
  }),
]

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name)

/** Definición JSON Schema para el parámetro `tools` de Ollama. */
export function toolSpecs(tools: ToolDef[] = TOOLS) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: cleanSchema(z.toJSONSchema(t.schema, { io: 'input' })) } }))
}

/** Quita ruido del JSON Schema que confunde a modelos pequeños ($schema, límites enteros de JS). */
export function cleanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchema)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === 'additionalProperties') continue
    if ((k === 'minimum' || k === 'maximum') && typeof v === 'number' && Math.abs(v) > 1e9) continue
    out[k] = cleanSchema(v)
  }
  return out
}
