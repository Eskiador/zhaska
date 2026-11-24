import { create } from 'zustand'
import type { BenchRecord, Hardware, InstalledModel, LoadedModel, OllamaStatus, PullProgress } from '@shared/ipc/contract'
import { REFERENCE_HARDWARE, type Hardware as CatalogHardware } from '@shared/models/catalog'
import { api, errorMessage, hasBackend, onEvent } from '@renderer/lib/api'
import { toast } from './ui'

export interface BenchRun {
  jobId: string
  model: string
  step: string
  index: number
  total: number
}

interface OllamaStore {
  status: OllamaStatus | null
  loaded: LoadedModel[]
  installed: InstalledModel[]
  hardware: Hardware | null
  /** Descargas activas o recién terminadas, por nombre de modelo */
  pulls: Record<string, PullProgress>
  installFraction: number | null
  benches: BenchRecord[]
  bench: BenchRun | null
  init: () => Promise<void>
  refreshModels: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  install: () => Promise<void>
  pull: (name: string) => Promise<void>
  cancelPull: (name: string) => Promise<void>
  remove: (name: string) => Promise<void>
  load: (name: string) => Promise<void>
  unload: (name: string) => Promise<void>
  runBench: (model: string) => Promise<void>
  cancelBench: () => Promise<void>
}

const fail = (title: string) => (e: unknown) => toast({ tone: 'error', title, description: errorMessage(e) })

export const useOllama = create<OllamaStore>((set, get) => ({
  status: null,
  loaded: [],
  installed: [],
  hardware: null,
  pulls: {},
  installFraction: null,
  benches: [],
  bench: null,

  init: async () => {
    if (!hasBackend) return
    onEvent('ollama.status', ({ status, loaded }) => {
      const wasConnected = get().status?.state === 'connected'
      set({ status, loaded })
      if (status.state === 'connected' && !wasConnected) void get().refreshModels()
    })
    onEvent('ollama.installProgress', ({ fraction }) => set({ installFraction: fraction }))
    onEvent('models.pull', (p) => {
      set({ pulls: { ...get().pulls, [p.name]: p } })
      if (p.phase === 'done') {
        toast({ tone: 'success', title: 'Modelo descargado', description: p.name })
        void get().refreshModels()
      } else if (p.phase === 'error') toast({ tone: 'error', title: `No se pudo descargar ${p.name}`, description: p.error ?? undefined })
      if (['done', 'error', 'cancelled'].includes(p.phase)) {
        setTimeout(() => {
          const pulls = { ...get().pulls }
          if (pulls[p.name]?.jobId === p.jobId) delete pulls[p.name]
          set({ pulls })
        }, 4000)
      }
    })
    onEvent('bench.event', (e) => {
      if (e.type === 'progress') set({ bench: { jobId: e.jobId, model: e.model, step: e.step ?? '', index: e.index ?? 0, total: e.total ?? 1 } })
      else {
        set({ bench: null })
        if (e.type === 'done' && e.record) {
          set({ benches: [e.record, ...get().benches] })
          toast({ tone: 'success', title: 'Banco de pruebas completado', description: e.model })
        } else if (e.type === 'error') toast({ tone: 'error', title: 'El banco de pruebas falló', description: e.error })
      }
    })
    const [st, hw, pulls, benches] = await Promise.all([
      api('ollama.status').catch(() => null),
      api('system.hardware').catch(() => null),
      api('models.pulls').catch(() => []),
      api('bench.list').catch(() => []),
    ])
    set({ status: st?.status ?? null, loaded: st?.loaded ?? [], hardware: hw, pulls: Object.fromEntries(pulls.map((p) => [p.name, p])), benches })
    if (st?.status.state === 'connected') await get().refreshModels()
  },

  refreshModels: async () => {
    try {
      set({ installed: await api('models.list') })
    } catch {
      set({ installed: [] })
    }
  },

  start: async () => {
    await api('ollama.start').then((status) => set({ status })).catch(fail('No se pudo iniciar Ollama'))
  },
  stop: async () => {
    await api('ollama.stop').catch(fail('No se pudo detener Ollama'))
  },
  install: async () => {
    try {
      set({ installFraction: 0 })
      const r = await api('ollama.install')
      if (r === 'opened-download') toast({ tone: 'info', title: 'Página de descarga abierta', description: 'Instala Ollama desde el navegador y vuelve: ZHASKA lo detectará solo.' })
      else toast({ tone: 'success', title: 'Ollama instalado' })
    } catch (e) {
      fail('No se pudo instalar Ollama')(e)
    } finally {
      set({ installFraction: null })
    }
  },
  pull: async (name) => {
    await api('models.pull', { name }).catch(fail(`No se pudo descargar ${name}`))
  },
  cancelPull: async (name) => {
    const p = get().pulls[name]
    if (p) await api('models.cancelPull', { jobId: p.jobId }).catch(() => {})
  },
  remove: async (name) => {
    await api('models.delete', { name })
      .then(() => toast({ tone: 'success', title: 'Modelo eliminado', description: name }))
      .catch(fail(`No se pudo eliminar ${name}`))
    await get().refreshModels()
  },
  load: async (name) => {
    await api('models.load', { name }).catch(fail(`No se pudo cargar ${name}`))
  },
  unload: async (name) => {
    await api('models.unload', { name }).catch(fail(`No se pudo liberar ${name}`))
  },
  runBench: async (model) => {
    try {
      const { jobId } = await api('bench.run', { model })
      set({ bench: { jobId, model, step: 'Preparando', index: 0, total: 6 } })
    } catch (e) {
      fail('No se pudo iniciar el banco de pruebas')(e)
    }
  },
  cancelBench: async () => {
    const b = get().bench
    if (b) await api('bench.cancel', { jobId: b.jobId }).catch(() => {})
  },
}))

/** Hardware para el catálogo: el detectado o, sin backend, el equipo de referencia. */
export function catalogHardware(hw: Hardware | null): CatalogHardware & { label: string; detected: boolean } {
  if (!hw) return { ...REFERENCE_HARDWARE, label: `${REFERENCE_HARDWARE.gpu} · ${REFERENCE_HARDWARE.vramGB} GB VRAM · ${REFERENCE_HARDWARE.ramGB} GB RAM`, detected: false }
  const ram = Math.round(hw.ramGB)
  const label = hw.unified
    ? `${hw.gpu ?? 'GPU integrada'} · ${ram} GB de memoria unificada`
    : hw.vramGB
      ? `${hw.gpu} · ${Math.round(hw.vramGB)} GB VRAM · ${ram} GB RAM`
      : `Sin GPU compatible · ${ram} GB RAM`
  return { vramGB: hw.vramGB ?? 0, ramGB: hw.ramGB, gpu: hw.gpu ?? 'CPU', unified: hw.unified, label, detected: true }
}

export const isInstalled = (installed: InstalledModel[], name: string) => installed.some((m) => m.name === name || m.name === `${name}:latest`)
