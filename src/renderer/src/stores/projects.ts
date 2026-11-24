import { create } from 'zustand'
import type { Project } from '@shared/ipc/contract'
import { api, errorMessage, hasBackend, onEvent } from '@renderer/lib/api'
import { useActivity } from './activity'
import { useChat } from './chat'
import { useOllama } from './ollama'
import { useSettings } from './settings'
import { toast, useUI } from './ui'
import { useUpdates } from './updates'
import { useWorkspace } from './workspace'

interface ProjectsStore {
  recents: Project[]
  defaultProjectsDir: string
  refresh: () => Promise<void>
}

export const useProjects = create<ProjectsStore>((set) => ({
  recents: [],
  defaultProjectsDir: '',
  refresh: async () => {
    if (!hasBackend) return
    try {
      set({ recents: await api('projects.list') })
    } catch (e) {
      toast({ tone: 'error', title: 'No se pudieron cargar los proyectos', description: errorMessage(e) })
    }
  },
}))

/** Activa un proyecto real: archivos, conversaciones y watcher. */
async function activate(p: Project) {
  const prev = useWorkspace.getState().project
  if (prev && !prev.demo && prev.id !== p.id) void api('projects.close', { id: prev.id }).catch(() => {})
  useActivity.getState().reset()
  useChat.getState().clear()
  await useWorkspace.getState().setProject(p)
  await useChat.getState().loadForProject(p.id)
  useSettings.getState().set('lastProjectId', p.id)
  void useProjects.getState().refresh()
}

const fail = (title: string) => (e: unknown) => {
  toast({ tone: 'error', title, description: errorMessage(e) })
  return false
}

export const openProjectById = (id: string) =>
  api('projects.open', { id })
    .then(activate)
    .then(() => true)
    .catch(fail('No se pudo abrir el proyecto'))

export const openFolderPath = (path: string) =>
  api('projects.openFolder', { path })
    .then(activate)
    .then(() => true)
    .catch(fail('No se pudo abrir la carpeta'))

export async function pickAndOpenFolder() {
  try {
    const path = await api('dialog.pickFolder', { title: 'Abrir carpeta como proyecto' })
    if (path) return openFolderPath(path)
  } catch (e) {
    fail('No se pudo abrir la carpeta')(e)
  }
  return false
}

/** Abre un proyecto recién creado (plantilla o clonado) y muestra sus avisos. */
export async function adoptProject(p: Project & { warnings?: string[] }) {
  await activate(p)
  p.warnings?.forEach((w) => toast({ tone: 'error', title: 'Proyecto creado con avisos', description: w }))
  if (!p.warnings?.length) toast({ tone: 'success', title: 'Proyecto listo', description: p.rootPath })
}

export async function createProject(input: { name: string; parentDir: string; gitInit: boolean; createGuide: boolean; description?: string }) {
  try {
    const p = await api('projects.create', input)
    await activate(p)
    p.warnings.forEach((w) => toast({ tone: 'error', title: 'Proyecto creado con avisos', description: w }))
    if (!p.warnings.length) toast({ tone: 'success', title: 'Proyecto creado', description: p.rootPath })
    return true
  } catch (e) {
    return fail('No se pudo crear el proyecto')(e)
  }
}

export async function forgetProject(id: string) {
  await api('projects.forget', { id }).catch(fail('No se pudo quitar de recientes'))
  if (useSettings.getState().lastProjectId === id) useSettings.getState().set('lastProjectId', null)
  await useProjects.getState().refresh()
}

export function closeProject() {
  const p = useWorkspace.getState().project
  if (p && !p.demo) void api('projects.close', { id: p.id }).catch(() => {})
  useWorkspace.getState().closeProject()
  useChat.getState().clear()
  useActivity.getState().reset()
  if (p && !p.demo) useSettings.getState().set('lastProjectId', null)
}

/** Proyecto de ejemplo con datos simulados (Fase 2), disponible siempre desde la bienvenida. */
export function openDemo() {
  const p = useWorkspace.getState().project
  if (p && !p.demo) void api('projects.close', { id: p.id }).catch(() => {})
  useWorkspace.getState().openDemoProject()
  useChat.getState().loadDemo()
  useActivity.getState().loadSnapshot()
}

/** Arranque: ajustes, recientes y último proyecto abierto. */
export async function bootstrap() {
  await useSettings.getState().hydrate()
  if (!hasBackend) {
    openDemo() // vista de navegador: solo demostración
    return
  }
  void useOllama.getState().init()
  void useChat.getState().initStreaming()
  onEvent('fs.changed', (batch) => {
    if (useWorkspace.getState().project?.id === batch.projectId) void useWorkspace.getState().applyFsChanges(batch)
  })
  if (!useSettings.getState().onboardingDone) useUI.getState().setOnboarding(true)
  const info = await api('app.info').catch(() => null)
  if (info) useProjects.setState({ defaultProjectsDir: info.defaultProjectsDir })
  if (info?.updatedFrom) toast({ tone: 'success', title: `ZHASKA se actualizó a la versión ${info.version}`, description: `Antes tenías la ${info.updatedFrom}. Tus proyectos, conversaciones y ajustes se conservan.` })
  void useUpdates.getState().init()
  // Resultado de una restauración o importación aplicada al arrancar (Fase 9)
  void api('data.lastOperation')
    .then((op) => {
      if (!op) return
      const what = op.kind === 'restore' ? 'la copia' : 'los datos'
      if (op.ok)
        toast({
          tone: 'success',
          title: op.kind === 'restore' ? 'Copia restaurada' : 'Datos importados',
          description: `${op.kind === 'restore' ? `Tus datos volvieron al ${op.label}.` : 'Se importaron correctamente.'}${op.safetyBackup ? ' Para deshacerlo, restaura la copia del estado anterior en Ajustes → Privacidad y datos.' : ''}`,
        })
      else toast({ tone: 'error', title: `No se pudo aplicar ${what}`, description: `${op.error ?? 'Error desconocido'}. Tus datos actuales no se han modificado.` })
    })
    .catch(() => {})
  await useProjects.getState().refresh()
  const { openLastProject, lastProjectId } = useSettings.getState()
  if (openLastProject && lastProjectId && useProjects.getState().recents.some((p) => p.id === lastProjectId && p.exists)) {
    await openProjectById(lastProjectId)
  }
}
