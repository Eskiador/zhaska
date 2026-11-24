import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { PathGuard } from '@core/security/pathGuard'
import { IGNORED_DIRS } from '@core/workspace/fileService'

export interface ChangeBatch {
  dirs: string[]
  files: string[]
}

/**
 * Observa el proyecto con `fs.watch` recursivo (nativo en Windows y macOS; Linux con Node ≥ 20)
 * y agrupa los cambios cada 150 ms. Ignora node_modules, .git, dist…
 */
export class ProjectWatcher {
  private watcher: FSWatcher | null = null
  private files = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly guard: PathGuard,
    private readonly onBatch: (batch: ChangeBatch) => void,
  ) {}

  start(): void {
    try {
      this.watcher = watch(this.guard.root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const rel = filename.toString().split(path.sep).join('/')
        if (rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) return
        if (/\.zhaska-[0-9a-f]{8}\.tmp$/.test(rel)) return // escrituras atómicas propias
        this.files.add(rel)
        this.schedule()
      })
      this.watcher.on('error', (e) => console.warn('[watcher]', e.message))
    } catch (e) {
      console.warn('[watcher] no disponible:', (e as Error).message)
    }
  }

  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const files = [...this.files]
      this.files.clear()
      const dirs = new Set<string>()
      for (const f of files) {
        const i = f.lastIndexOf('/')
        dirs.add(i < 0 ? '' : f.slice(0, i))
        dirs.add(f) // por si es una carpeta
      }
      this.onBatch({ dirs: [...dirs], files })
    }, 150)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.files.clear()
  }
}
