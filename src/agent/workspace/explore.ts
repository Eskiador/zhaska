import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { IGNORED_DIRS } from '@core/workspace/fileService'
import type { PathGuard } from '@core/security/pathGuard'

const HIDDEN = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** Árbol del proyecto en texto, acotado en profundidad y número de entradas. */
export async function projectTree(guard: PathGuard, rel: string, maxDepth: number, maxEntries = 300): Promise<string> {
  const lines: string[] = []
  let count = 0
  let truncated = false
  const walk = async (dirRel: string, depth: number, indent: string) => {
    if (count >= maxEntries) return void (truncated = true)
    const abs = guard.resolve(dirRel)
    const entries = (await readdir(abs, { withFileTypes: true }).catch(() => []))
      .filter((d) => !HIDDEN.has(d.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    for (const d of entries) {
      if (count >= maxEntries) return void (truncated = true)
      count++
      const childRel = dirRel ? `${dirRel}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name)) {
          lines.push(`${indent}${d.name}/ (omitido)`)
          continue
        }
        lines.push(`${indent}${d.name}/`)
        if (depth < maxDepth) await walk(childRel, depth + 1, `${indent}  `)
      } else lines.push(`${indent}${d.name}`)
    }
  }
  await walk(guard.normalizeRel(rel), 1, '')
  if (truncated) lines.push(`… (más de ${maxEntries} entradas; usa list_files en una carpeta concreta)`)
  return lines.join('\n') || '(carpeta vacía)'
}

export interface SearchHit {
  file: string
  line: number
  text: string
}

/** Búsqueda de texto o regex en el proyecto (sin dependencias; ripgrep se evaluará en la Fase 11). */
/**
 * Búsqueda en el contenido del proyecto (Fase 11: proyectos grandes). Primero se recorren las carpetas (sin
 * dependencias, compilados ni ocultas) y luego se leen los archivos en paralelo, hasta 100 000 archivos o
 * 8 segundos. Los resultados salen ordenados por archivo y línea.
 */
export async function searchCode(
  guard: PathGuard,
  query: string,
  opts: { regex: boolean; glob?: string; caseSensitive: boolean; maxResults: number; exclude?: (rel: string) => boolean; timeBudgetMs?: number },
): Promise<{ hits: SearchHit[]; filesScanned: number; truncated: boolean; excluded: number }> {
  const re = opts.regex ? new RegExp(query, opts.caseSensitive ? '' : 'i') : null
  const needle = opts.caseSensitive ? query : query.toLowerCase()
  const globRe = opts.glob ? globToRegExp(opts.glob) : null
  const deadline = Date.now() + (opts.timeBudgetMs ?? 8000)
  const MAX_FILES = 100_000
  const hits: SearchHit[] = []
  let filesScanned = 0
  let excluded = 0
  let truncated = false

  // 1. Lista de archivos candidatos
  const files: string[] = []
  const stack = ['']
  while (stack.length) {
    if (files.length >= MAX_FILES || Date.now() > deadline) {
      truncated = true
      break
    }
    const dirRel = stack.pop()!
    const entries = await readdir(guard.resolve(dirRel), { withFileTypes: true }).catch(() => [])
    for (const d of entries) {
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (!IGNORED_DIRS.has(d.name) && !d.name.startsWith('.')) stack.push(rel)
        continue
      }
      if (!d.isFile() || (globRe && !globRe.test(rel) && !globRe.test(d.name))) continue
      // Archivos protegidos (.env, claves…): su contenido no entra en la búsqueda
      if (opts.exclude?.(rel)) {
        excluded++
        continue
      }
      files.push(rel)
    }
  }
  files.sort()

  // 2. Lectura en paralelo (32 a la vez)
  const found = new Map<string, SearchHit[]>()
  let next = 0
  let total = 0
  const worker = async () => {
    for (;;) {
      if (total >= opts.maxResults || Date.now() > deadline) {
        if (next < files.length) truncated = true
        return
      }
      const i = next++
      if (i >= files.length) return
      const rel = files[i]!
      const abs = guard.resolve(rel)
      const st = await stat(abs).catch(() => null)
      if (!st || st.size > 1_000_000) continue
      const buf = await readFile(abs).catch(() => null)
      if (!buf || buf.subarray(0, 8000).includes(0)) continue
      filesScanned++
      const mine: SearchHit[] = []
      buf
        .toString('utf8')
        .split(/\r?\n/)
        .forEach((line, n) => {
          if (total >= opts.maxResults) return
          const ok = re ? re.test(line) : (opts.caseSensitive ? line : line.toLowerCase()).includes(needle)
          if (ok) {
            mine.push({ file: rel, line: n + 1, text: line.trim().slice(0, 200) })
            total++
          }
        })
      if (mine.length) found.set(rel, mine)
    }
  }
  await Promise.all(Array.from({ length: 32 }, worker))
  for (const rel of files) for (const h of found.get(rel) ?? []) if (hits.length < opts.maxResults) hits.push(h)
  if (total >= opts.maxResults) truncated = true
  return { hits, filesScanned, truncated, excluded }
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
  return new RegExp(`^${esc}$`, 'i')
}

export interface ProjectInfo {
  kind: string[]
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null
  scripts: Record<string, string>
  dependencies: string[]
  devDependencies: string[]
  typescript: boolean
  python: boolean
  testCommand: string[] | null
  typecheckCommand: string[] | null
  summary: string
}

/** Detecta el tipo de proyecto y sus comandos (sin ejecutar nada). */
export async function detectProject(root: string): Promise<ProjectInfo> {
  const has = (f: string) => existsSync(path.join(root, f))
  const info: ProjectInfo = { kind: [], packageManager: null, scripts: {}, dependencies: [], devDependencies: [], typescript: false, python: false, testCommand: null, typecheckCommand: null, summary: '' }
  const lines: string[] = []
  if (has('package.json')) {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}')) as { name?: string; version?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    info.kind.push('node')
    info.packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm'
    info.scripts = pkg.scripts ?? {}
    info.dependencies = Object.keys(pkg.dependencies ?? {})
    info.devDependencies = Object.keys(pkg.devDependencies ?? {})
    lines.push(`package.json: ${pkg.name ?? '(sin nombre)'} ${pkg.version ?? ''} · gestor: ${info.packageManager}${has('node_modules') ? '' : ' · node_modules NO instalado'}`)
    if (Object.keys(info.scripts).length) lines.push(`scripts: ${Object.entries(info.scripts).map(([k, v]) => `${k} → ${v}`).join(' · ')}`)
    if (info.dependencies.length) lines.push(`dependencias: ${info.dependencies.join(', ')}`)
    if (info.devDependencies.length) lines.push(`dependencias de desarrollo: ${info.devDependencies.join(', ')}`)
    if (info.scripts['test'] && !/no test specified/.test(info.scripts['test'])) info.testCommand = [info.packageManager, info.packageManager === 'npm' ? 'test' : 'test']
  }
  if (has('tsconfig.json')) {
    info.typescript = true
    info.kind.push('typescript')
    lines.push('tsconfig.json presente')
    info.typecheckCommand = info.scripts['typecheck'] ? [info.packageManager ?? 'npm', 'run', 'typecheck'] : ['npx', '--no-install', 'tsc', '--noEmit']
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    info.python = true
    info.kind.push('python')
    lines.push(['pyproject.toml', 'requirements.txt', 'setup.py'].filter(has).join(', ') + ' presente(s)')
    info.testCommand ??= has('pytest.ini') || has('tests') || has('conftest.py') ? ['python', '-m', 'pytest', '-q'] : null
    info.typecheckCommand ??= ['python', '-m', 'compileall', '-q', '.']
  }
  for (const [f, k] of [['Cargo.toml', 'rust'], ['go.mod', 'go'], ['pom.xml', 'java'], ['composer.json', 'php'], ['Gemfile', 'ruby']] as const) {
    if (has(f)) {
      info.kind.push(k)
      lines.push(`${f} presente`)
    }
  }
  if (has('.git')) lines.push('repositorio Git')
  info.summary = lines.join('\n') || 'No se detectó ningún archivo de configuración conocido.'
  return info
}

export { parseDiagnostics } from '@shared/agent/diagnostics'
