import { existsSync, promises as fsp, readFileSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { Project } from '@shared/ipc/contract'
import { AppError, fromNodeError } from '@core/errors'
import type { ProjectRecord, ProjectsRepo } from '../db/repos'
import { runCommand, defaultShell } from '@core/commands/runner'

/** Enriquecer el registro de la BD con el estado real de la carpeta (existe, Git, rama). */
export function describeProject(r: ProjectRecord): Project {
  const exists = existsSync(r.rootPath)
  const gitDir = path.join(r.rootPath, '.git')
  const isGit = exists && existsSync(gitDir)
  return { id: r.id, name: r.name, rootPath: r.rootPath, createdAt: r.createdAt, lastOpenedAt: r.lastOpenedAt, exists, isGit, branch: isGit ? readBranch(gitDir) : null }
}

/** Rama actual leyendo .git/HEAD (no requiere tener Git instalado). */
export function readBranch(gitDir: string): string | null {
  try {
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m ? m[1]! : head.slice(0, 7) // HEAD separado: hash corto
  } catch {
    return null
  }
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Nombre de carpeta válido en Windows, macOS y Linux. */
export function validateProjectName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new AppError('INVALID_INPUT', 'El nombre del proyecto no puede estar vacío')
  if (name === '.' || name === '..') throw new AppError('INVALID_INPUT', 'Nombre de proyecto no válido')
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new AppError('INVALID_INPUT', 'El nombre no puede contener < > : " / \\ | ? *')
  if (WIN_RESERVED.test(name)) throw new AppError('INVALID_INPUT', `"${name}" es un nombre reservado de Windows`)
  if (/[. ]$/.test(name)) throw new AppError('INVALID_INPUT', 'El nombre no puede terminar en punto o espacio')
  return name
}

const GUIDE = (name: string, description?: string) => `# ${name}

Instrucciones del proyecto para el agente de ZHASKA. El agente lee este archivo al empezar cada tarea.

## Descripción
${description?.trim() || '<!-- ¿Qué hace este proyecto y para quién? -->'}

## Tecnologías y convenciones
<!-- Lenguajes, frameworks, estilo de código, estructura de carpetas… -->

## Comandos
<!-- Cómo se instala, se ejecuta, se compila y se prueba. -->

## Reglas
<!-- Lo que el agente debe evitar o respetar siempre. -->
`

const GITIGNORE = `node_modules/
dist/
build/
.env
.env.*
!.env.example
*.log
.DS_Store
Thumbs.db
`

function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || stderr || err?.message || '').trim() }))
  })
}

/**
 * Política de carpetas (Fase 9):
 * - `rootProblem`: carpetas que nunca pueden ser un proyecto (sistema, raíz del disco, datos de ZHASKA…).
 * - `chosen`: la interfaz solo puede abrir o crear proyectos en carpetas que el usuario eligió en el selector
 *   nativo, arrastró a la ventana o configuró como carpeta de proyectos. Así una interfaz comprometida no
 *   puede convertir cualquier ruta del disco en un proyecto que el agente pueda tocar.
 */
export interface ProjectPolicy {
  rootProblem: (real: string) => string | null
  chosen: (abs: string) => boolean
}

const OPEN_POLICY: ProjectPolicy = { rootProblem: () => null, chosen: () => true }

export class ProjectService {
  constructor(
    private readonly repo: ProjectsRepo,
    private readonly policy: ProjectPolicy = OPEN_POLICY,
  ) {}

  list(): Project[] {
    return this.repo.listRecent().map(describeProject)
  }

  /** Carpeta elegida por el usuario (selector, arrastrar) o de un proyecto ya conocido. */
  async openFolder(folder: string): Promise<Project> {
    if (!path.isAbsolute(folder)) throw new AppError('INVALID_INPUT', 'Se esperaba una ruta absoluta')
    if (!this.policy.chosen(folder) && !this.repo.findByRoot(folder)) throw new AppError('FORBIDDEN_PATH', 'Por seguridad, elige la carpeta con el selector o arrástrala a la ventana.')
    return this.openTrusted(folder)
  }

  private async openTrusted(folder: string): Promise<Project> {
    let real: string
    try {
      real = await fsp.realpath(folder)
      if (!statSync(real).isDirectory()) throw new AppError('INVALID_INPUT', 'La ruta no es una carpeta')
    } catch (e) {
      throw fromNodeError(e, folder)
    }
    if (path.parse(real).root === real) throw new AppError('FORBIDDEN_PATH', 'No se puede abrir la raíz de un disco como proyecto')
    const problem = this.policy.rootProblem(real)
    if (problem) throw new AppError('FORBIDDEN_PATH', `No se puede usar como proyecto. ${problem}`)
    return describeProject(this.repo.touchByRoot(real, path.basename(real)))
  }

  open(id: string): Project {
    const p = describeProject(this.repo.get(id))
    if (!p.exists) throw new AppError('NOT_FOUND', `La carpeta del proyecto ya no existe: ${p.rootPath}`)
    const problem = this.policy.rootProblem(p.rootPath)
    if (problem) throw new AppError('FORBIDDEN_PATH', `No se puede usar como proyecto. ${problem}`)
    return describeProject(this.repo.touch(id))
  }

  /** La ubicación de un proyecto nuevo debe haberla elegido el usuario; y el destino no puede ser sensible. */
  private target(parentDir: string, name: string): string {
    if (!path.isAbsolute(parentDir)) throw new AppError('INVALID_INPUT', 'La ubicación debe ser una ruta absoluta')
    if (!this.policy.chosen(parentDir)) throw new AppError('FORBIDDEN_PATH', 'Por seguridad, elige la ubicación con el selector de carpetas.')
    const target = path.join(parentDir, name)
    const problem = this.policy.rootProblem(target)
    if (problem) throw new AppError('FORBIDDEN_PATH', `No se puede crear el proyecto ahí. ${problem}`)
    return target
  }

  async create(input: { name: string; parentDir: string; gitInit: boolean; createGuide: boolean; description?: string }): Promise<Project & { warnings: string[] }> {
    const name = validateProjectName(input.name)
    const target = this.target(input.parentDir, name)
    const warnings: string[] = []
    try {
      await fsp.mkdir(input.parentDir, { recursive: true })
      await fsp.mkdir(target) // falla si ya existe
      if (input.createGuide) await fsp.writeFile(path.join(target, 'ZHASKA.md'), GUIDE(name, input.description), { flag: 'wx' })
    } catch (e) {
      throw fromNodeError(e, target)
    }
    if (input.gitInit) {
      const r = await run('git', ['init', '-b', 'main'], target)
      if (r.ok) await fsp.writeFile(path.join(target, '.gitignore'), GITIGNORE, { flag: 'wx' }).catch(() => {})
      else warnings.push('No se pudo inicializar Git (¿está instalado?). El proyecto se creó sin repositorio.')
    }
    const project = await this.openTrusted(target)
    return { ...project, warnings }
  }

  /**
   * Proyecto desde plantilla: ejecuta el generador oficial (sin shell, nombre validado), luego Git,
   * ZHASKA.md y, si se pide, instala dependencias. La salida se envía línea a línea a la interfaz.
   */
  async createFromTemplate(
    input: { name: string; parentDir: string; template: 'react-vite' | 'next'; gitInit: boolean; createGuide: boolean; description?: string; install: boolean },
    log: (line: string) => void,
  ): Promise<Project & { warnings: string[] }> {
    const name = validateProjectName(input.name)
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new AppError('INVALID_INPUT', 'Para las plantillas, el nombre debe ir en minúsculas y sin espacios (letras, números, «-», «_» o «.»)')
    const target = this.target(input.parentDir, name)
    if (existsSync(target)) throw new AppError('EXISTS', `Ya existe ${target}`)
    await fsp.mkdir(input.parentDir, { recursive: true })
    const shell = defaultShell('powershell')
    const step = async (file: string, args: string[], cwd: string, timeoutMs: number, what: string) => {
      log(`$ ${file} ${args.join(' ')}`)
      const r = await runCommand({ file, args, cwd, shell, timeoutMs, onOutput: (l) => l.trim() && log(l) })
      if (r.exitCode !== 0) throw new AppError('IO', `${what} falló (${r.timedOut ? 'tiempo agotado' : `código ${r.exitCode}`}). Revisa la salida.`)
    }
    const [file, args] =
      input.template === 'react-vite'
        ? ['npm', ['create', 'vite@latest', name, '--', '--template', 'react-ts']]
        : ['npx', ['--yes', 'create-next-app@latest', name, '--ts', '--app', '--eslint', '--tailwind', '--src-dir', '--use-npm', '--yes', '--skip-install', '--disable-git']]
    await step(file, args as string[], input.parentDir, 300_000, 'La plantilla')
    const warnings: string[] = []
    if (input.createGuide && !existsSync(path.join(target, 'ZHASKA.md'))) await fsp.writeFile(path.join(target, 'ZHASKA.md'), GUIDE(name, input.description), { flag: 'wx' })
    if (input.gitInit) {
      const r = await run('git', ['init', '-b', 'main'], target)
      if (r.ok) {
        if (!existsSync(path.join(target, '.gitignore'))) await fsp.writeFile(path.join(target, '.gitignore'), GITIGNORE, { flag: 'wx' }).catch(() => {})
        log('$ git init -b main')
      } else warnings.push('No se pudo inicializar Git (¿está instalado?).')
    }
    if (input.install) {
      try {
        await step('npm', ['install'], target, 600_000, 'La instalación de dependencias')
      } catch (e) {
        warnings.push(`${(e as Error).message} Puedes ejecutar «npm install» desde la terminal.`)
      }
    }
    return { ...(await this.openTrusted(target)), warnings }
  }

  /** Clona un repositorio Git (https o ssh) en una carpeta nueva y la abre. */
  async clone(input: { url: string; parentDir: string; name?: string }, log: (line: string) => void): Promise<Project> {
    const url = input.url.trim()
    if (!/^(https:\/\/[\w.-]+\/[\w./~-]+|git@[\w.-]+:[\w./~-]+)$/.test(url)) throw new AppError('INVALID_INPUT', 'URL de repositorio no válida (https://… o git@…:…)')
    const name = validateProjectName(input.name?.trim() || url.split(/[/:]/).pop()!.replace(/\.git$/, ''))
    const target = this.target(input.parentDir, name)
    if (existsSync(target)) throw new AppError('EXISTS', `Ya existe ${target}`)
    await fsp.mkdir(input.parentDir, { recursive: true })
    log(`$ git clone ${url} ${name}`)
    const r = await runCommand({ file: 'git', args: ['clone', '--progress', url, name], cwd: input.parentDir, shell: defaultShell('powershell'), timeoutMs: 900_000, onOutput: (l) => l.trim() && log(l) })
    if (r.exitCode !== 0) throw new AppError('IO', r.output.includes('not found') || r.output.includes('ENOENT') ? 'Git no está instalado en este equipo.' : `No se pudo clonar (código ${r.exitCode}). Revisa la URL y la salida.`)
    return this.openTrusted(target)
  }

  rename(id: string, name: string): Project {
    return describeProject(this.repo.rename(id, name))
  }

  forget(id: string): void {
    this.repo.hide(id)
  }
}
