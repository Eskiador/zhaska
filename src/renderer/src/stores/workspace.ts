import { create } from 'zustand'
import type { DirEntry, FileChange, Project } from '@shared/ipc/contract'
import { api, ApiError, errorMessage } from '@renderer/lib/api'
import { DEMO_FILES, DEMO_PROJECT } from '@renderer/demo/project'
import { toast } from './ui'

export interface ActiveProject extends Project {
  demo: boolean
}

export interface OpenFile {
  content: string
  /** Último contenido guardado / leído de disco: dirty = content !== saved */
  saved: string
  encoding: 'utf8' | 'utf8-bom'
  eol: 'LF' | 'CRLF'
  mtimeMs: number
  unsupported: 'binary' | 'too-large' | null
  loading: boolean
  error?: string
  /** El archivo cambió en disco mientras tenía cambios sin guardar */
  conflict: boolean
  /** Contenido previo a los cambios del agente (vista diff) */
  original?: string
  changedBy?: 'agent' | 'user'
}

export interface PendingEntry {
  parent: string
  kind: 'file' | 'dir'
}

interface WorkspaceStore {
  project: ActiveProject | null
  dirs: Record<string, DirEntry[]>
  expanded: Set<string>
  files: Record<string, OpenFile>
  openTabs: string[]
  activeTab: string | null
  diffTabs: Set<string>
  renaming: string | null
  creating: PendingEntry | null

  setProject: (p: Project) => Promise<void>
  openDemoProject: () => void
  closeProject: () => void
  loadDir: (rel: string) => Promise<void>
  toggleDir: (rel: string) => void
  openFile: (rel: string, opts?: { diff?: boolean }) => Promise<void>
  closeTab: (rel: string) => void
  setActive: (rel: string) => void
  toggleDiff: (rel: string) => void
  updateBuffer: (rel: string, content: string) => void
  save: (rel: string, opts?: { force?: boolean }) => Promise<boolean>
  reloadFromDisk: (rel: string) => Promise<void>
  applyFsChanges: (batch: { dirs: string[]; files: string[] }) => Promise<void>
  startCreate: (parent: string, kind: 'file' | 'dir') => void
  startRename: (rel: string | null) => void
  cancelPending: () => void
  createEntry: (parent: string, name: string, kind: 'file' | 'dir') => Promise<void>
  renameEntry: (rel: string, newName: string) => Promise<void>
  trashEntry: (rel: string) => Promise<void>
  /** Cambios del agente pendientes de revisar, por ruta (marcas A/M y propuestas en el editor) */
  pending: Record<string, FileChange>
  loadPending: () => Promise<void>
  /** Abre un archivo con cambios pendientes en modo «Cambios» (propuestas) */
  reviewChange: (rel: string) => Promise<void>
  /** Petición de mostrar una línea (panel Problemas) */
  reveal: { rel: string; line: number; n: number } | null
  openAt: (rel: string, line: number) => Promise<void>
  /** Abre la vista diff de un cambio del agente (original guardado → contenido actual). */
  openAgentDiff: (rel: string, before: string | null) => Promise<void>
}

const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)
const isUnder = (rel: string, base: string) => rel === base || rel.startsWith(`${base}/`)

export const isDirty = (f: OpenFile | undefined) => !!f && !f.loading && !f.unsupported && f.content !== f.saved

/** Rutas de archivo conocidas (carpetas ya cargadas): menciones @ y búsqueda rápida. */
export function knownFiles(dirs: Record<string, DirEntry[]>): string[] {
  return Object.values(dirs)
    .flat()
    .filter((e) => e.kind === 'file')
    .map((e) => e.rel)
    .sort()
}

function demoDirs(): Record<string, DirEntry[]> {
  const dirs: Record<string, DirEntry[]> = {}
  const add = (parent: string, entry: DirEntry) => {
    const list = (dirs[parent] ??= [])
    if (!list.some((e) => e.rel === entry.rel)) list.push(entry)
  }
  for (const f of DEMO_FILES) {
    const parts = f.path.split('/')
    parts.forEach((name, i) => {
      const rel = parts.slice(0, i + 1).join('/')
      const parent = parts.slice(0, i).join('/')
      const isFile = i === parts.length - 1
      add(parent, { name, rel, kind: isFile ? 'file' : 'dir', ignored: false, symlink: false, size: isFile ? f.content.length : undefined })
    })
  }
  for (const list of Object.values(dirs)) list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  return dirs
}

const empty = {
  project: null,
  dirs: {},
  expanded: new Set<string>(),
  files: {},
  openTabs: [],
  activeTab: null,
  diffTabs: new Set<string>(),
  renaming: null,
  creating: null,
  reveal: null,
  pending: {} as Record<string, FileChange>,
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  const patchFile = (rel: string, p: Partial<OpenFile>) => {
    const cur = get().files[rel]
    if (cur) set({ files: { ...get().files, [rel]: { ...cur, ...p } } })
  }
  const projectId = () => {
    const p = get().project
    if (!p || p.demo) throw new ApiError('INTERNAL', 'El proyecto de demostración no tiene archivos en disco')
    return p.id
  }
  const report = (title: string) => (e: unknown) => toast({ tone: 'error', title, description: errorMessage(e) })

  return {
    ...empty,

    setProject: async (p) => {
      set({ ...empty, project: { ...p, demo: false }, expanded: new Set(), diffTabs: new Set(), pending: {} })
      await get().loadDir('')
      await get().loadPending()
    },

    loadPending: async () => {
      const p = get().project
      if (!p || p.demo) return
      const list = await api('changes.pending', { projectId: p.id }).catch(() => [])
      if (get().project?.id !== p.id) return
      const pending = Object.fromEntries(list.map((c) => [c.rel, c]))
      // Archivos que ya no tienen cambios pendientes salen del modo «Cambios»
      const diffTabs = new Set([...get().diffTabs].filter((r) => pending[r] || get().files[r]?.changedBy !== 'agent'))
      set({ pending, diffTabs })
    },

    reviewChange: async (rel) => {
      const c = get().pending[rel]
      if (!c) return get().openFile(rel)
      const contents = await api('changes.contents', { taskId: c.taskId, rel }).catch(() => null)
      if (!contents || contents.after === null) return get().openFile(rel)
      await get().openAgentDiff(rel, contents.before)
    },

    openDemoProject: () => {
      const files: Record<string, OpenFile> = Object.fromEntries(
        DEMO_FILES.map((f) => [
          f.path,
          { content: f.content, saved: f.content, encoding: 'utf8', eol: 'LF', mtimeMs: 0, unsupported: null, loading: false, conflict: false, original: f.original, changedBy: f.changedBy },
        ]),
      )
      set({
        ...empty,
        project: { id: DEMO_PROJECT.id, name: DEMO_PROJECT.name, rootPath: DEMO_PROJECT.root, createdAt: 0, lastOpenedAt: 0, exists: true, isGit: true, branch: DEMO_PROJECT.branch, demo: true },
        dirs: demoDirs(),
        expanded: new Set(['src', 'src/components']),
        files,
        openTabs: ['src/components/Dashboard.tsx', 'src/components/SalesChart.tsx', 'package.json'],
        activeTab: 'src/components/Dashboard.tsx',
        diffTabs: new Set(),
      })
    },

    closeProject: () => set({ ...empty, expanded: new Set(), diffTabs: new Set() }),

    loadDir: async (rel) => {
      const p = get().project
      if (!p || p.demo) return
      try {
        const entries = await api('fs.list', { projectId: p.id, rel })
        if (get().project?.id !== p.id) return
        set({ dirs: { ...get().dirs, [rel]: entries } })
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NOT_FOUND') {
          // La carpeta ya no existe: olvidar su listado
          const dirs = { ...get().dirs }
          delete dirs[rel]
          set({ dirs })
        } else report('No se pudo leer la carpeta')(e)
      }
    },

    toggleDir: (rel) => {
      const expanded = new Set(get().expanded)
      if (expanded.has(rel)) expanded.delete(rel)
      else {
        expanded.add(rel)
        if (!get().dirs[rel]) void get().loadDir(rel)
      }
      set({ expanded })
    },

    openFile: async (rel, opts) => {
      const { openTabs, diffTabs, files, project } = get()
      const nextDiff = new Set(diffTabs)
      if (opts?.diff) nextDiff.add(rel)
      set({ openTabs: openTabs.includes(rel) ? openTabs : [...openTabs, rel], activeTab: rel, diffTabs: nextDiff })
      if (files[rel] || !project || project.demo) return
      set({ files: { ...get().files, [rel]: { content: '', saved: '', encoding: 'utf8', eol: 'LF', mtimeMs: 0, unsupported: null, loading: true, conflict: false } } })
      try {
        const f = await api('fs.read', { projectId: project.id, rel })
        patchFile(rel, { content: f.content, saved: f.content, encoding: f.encoding, eol: f.eol, mtimeMs: f.mtimeMs, unsupported: f.unsupported, loading: false })
      } catch (e) {
        patchFile(rel, { loading: false, error: errorMessage(e) })
      }
    },

    closeTab: (rel) => {
      const { openTabs, activeTab, files, project } = get()
      const idx = openTabs.indexOf(rel)
      const rest = openTabs.filter((p) => p !== rel)
      const nextFiles = { ...files }
      if (!project?.demo && !isDirty(files[rel])) delete nextFiles[rel] // liberar memoria
      set({ openTabs: rest, files: nextFiles, activeTab: activeTab === rel ? (rest[Math.min(idx, rest.length - 1)] ?? null) : activeTab })
    },

    setActive: (rel) => set({ activeTab: rel }),

    toggleDiff: (rel) => {
      const d = new Set(get().diffTabs)
      if (d.has(rel)) d.delete(rel)
      else d.add(rel)
      set({ diffTabs: d })
    },

    updateBuffer: (rel, content) => patchFile(rel, { content }),

    save: async (rel, opts) => {
      const f = get().files[rel]
      const p = get().project
      if (!f || !p || f.unsupported || f.loading) return false
      if (p.demo) {
        toast({ tone: 'info', title: 'Proyecto de demostración', description: 'Sus archivos solo existen en memoria; abre una carpeta real para guardar en disco.' })
        return false
      }
      const content = f.content
      try {
        const r = await api('fs.write', { projectId: p.id, rel, content, encoding: f.encoding, expectedMtimeMs: opts?.force ? undefined : f.mtimeMs })
        patchFile(rel, { saved: content, mtimeMs: r.mtimeMs, conflict: false })
        return true
      } catch (e) {
        if (e instanceof ApiError && e.code === 'CONFLICT') {
          patchFile(rel, { conflict: true })
          toast({ tone: 'error', title: 'El archivo cambió en disco', description: `${rel}: elige recargar o sobrescribir en el editor.` })
        } else report(`No se pudo guardar ${rel}`)(e)
        return false
      }
    },

    reloadFromDisk: async (rel) => {
      const p = get().project
      if (!p || p.demo) return
      try {
        const f = await api('fs.read', { projectId: p.id, rel })
        patchFile(rel, { content: f.content, saved: f.content, mtimeMs: f.mtimeMs, encoding: f.encoding, eol: f.eol, unsupported: f.unsupported, conflict: false })
      } catch (e) {
        report(`No se pudo recargar ${rel}`)(e)
      }
    },

    applyFsChanges: async ({ dirs, files }) => {
      const p = get().project
      if (!p || p.demo) return
      const loaded = get().dirs
      await Promise.all(dirs.filter((d) => d in loaded).map((d) => get().loadDir(d)))
      for (const rel of files) {
        const f = get().files[rel]
        if (!f || f.loading) continue
        try {
          const disk = await api('fs.read', { projectId: p.id, rel })
          if (disk.content === f.saved) {
            patchFile(rel, { mtimeMs: disk.mtimeMs })
            continue
          }
          if (isDirty(f)) patchFile(rel, { conflict: true, mtimeMs: f.mtimeMs })
          else patchFile(rel, { content: disk.content, saved: disk.content, mtimeMs: disk.mtimeMs, eol: disk.eol, encoding: disk.encoding })
        } catch (e) {
          if (e instanceof ApiError && e.code === 'NOT_FOUND') patchFile(rel, { error: 'El archivo se eliminó o movió fuera del editor' })
        }
      }
    },

    startCreate: (parent, kind) => {
      const expanded = new Set(get().expanded)
      if (parent) expanded.add(parent)
      set({ creating: { parent, kind }, renaming: null, expanded })
      if (parent && !get().dirs[parent]) void get().loadDir(parent)
    },
    startRename: (rel) => set({ renaming: rel, creating: null }),
    cancelPending: () => set({ renaming: null, creating: null }),

    createEntry: async (parent, name, kind) => {
      const rel = join(parent, name.trim())
      set({ creating: null })
      try {
        await api('fs.create', { projectId: projectId(), rel, kind })
        await get().loadDir(parent)
        if (kind === 'file') await get().openFile(rel)
        else get().toggleDir(rel)
      } catch (e) {
        report(kind === 'file' ? 'No se pudo crear el archivo' : 'No se pudo crear la carpeta')(e)
      }
    },

    renameEntry: async (rel, newName) => {
      set({ renaming: null })
      const to = join(parentOf(rel), newName.trim())
      if (to === rel || !newName.trim()) return
      try {
        await api('fs.rename', { projectId: projectId(), from: rel, to })
        // Reasignar pestañas y buffers abiertos bajo la ruta renombrada
        const remap = (p: string) => (isUnder(p, rel) ? to + p.slice(rel.length) : p)
        const { files, openTabs, activeTab, diffTabs, expanded } = get()
        set({
          files: Object.fromEntries(Object.entries(files).map(([k, v]) => [remap(k), v])),
          openTabs: openTabs.map(remap),
          activeTab: activeTab ? remap(activeTab) : null,
          diffTabs: new Set([...diffTabs].map(remap)),
          expanded: new Set([...expanded].map(remap)),
        })
        await get().loadDir(parentOf(rel))
      } catch (e) {
        report('No se pudo renombrar')(e)
      }
    },

    openAt: async (rel, line) => {
      const diff = new Set(get().diffTabs)
      diff.delete(rel)
      set({ diffTabs: diff })
      await get().openFile(rel)
      set({ reveal: { rel, line, n: (get().reveal?.n ?? 0) + 1 } })
    },

    openAgentDiff: async (rel, before) => {
      const f = get().files[rel]
      if (f) patchFile(rel, { original: before ?? '', changedBy: 'agent' })
      await get().openFile(rel, { diff: true })
      patchFile(rel, { original: before ?? '', changedBy: 'agent' })
    },

    trashEntry: async (rel) => {
      try {
        await api('fs.trash', { projectId: projectId(), rel })
        const { openTabs, files, activeTab } = get()
        const keep = openTabs.filter((t) => !isUnder(t, rel))
        set({
          openTabs: keep,
          activeTab: activeTab && isUnder(activeTab, rel) ? (keep[0] ?? null) : activeTab,
          files: Object.fromEntries(Object.entries(files).filter(([k]) => !isUnder(k, rel))),
        })
        await get().loadDir(parentOf(rel))
        toast({ tone: 'success', title: 'Movido a la papelera', description: rel })
      } catch (e) {
        report('No se pudo eliminar')(e)
      }
    },
  }
})
