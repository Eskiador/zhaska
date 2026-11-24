import { create } from 'zustand'
import type { UpdateStatus } from '@shared/ipc/contract'
import { api, errorMessage, hasBackend, onEvent } from '@renderer/lib/api'
import { toast } from './ui'

/** Estado de las actualizaciones (main → electron-updater). Descargar e instalar siempre los decide el usuario. */
export const useUpdates = create<{
  status: UpdateStatus | null
  init: () => Promise<void>
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
}>((set, get) => {
  let announced: string | null = null
  const apply = (s: UpdateStatus) => {
    set({ status: s })
    if (s.state === 'available' && s.version && announced !== s.version) {
      announced = s.version
      toast({ tone: 'info', title: `ZHASKA ${s.version} disponible`, description: 'Descárgala cuando quieras desde la barra de estado o en Configuración → Acerca de ZHASKA.' })
    }
    if (s.state === 'downloaded') toast({ tone: 'success', title: `ZHASKA ${s.version} descargada y verificada`, description: 'Se instalará cuando pulses «Reiniciar e instalar». Antes se guarda una copia de tus datos.' })
  }
  const run = async (fn: () => Promise<UpdateStatus | void>, what: string) => {
    try {
      const s = await fn()
      if (s) apply(s)
    } catch (e) {
      toast({ tone: 'error', title: what, description: errorMessage(e) })
    }
  }
  return {
    status: null,
    init: async () => {
      if (!hasBackend) return
      onEvent('update.status', apply)
      set({ status: await api('update.status').catch(() => null) })
      // Si ya estaba disponible antes de abrir la ventana, no se repite el aviso
      announced = get().status?.version ?? null
    },
    check: () => run(() => api('update.check'), 'No se pudo buscar actualizaciones'),
    download: () => run(() => api('update.download'), 'No se pudo descargar la actualización'),
    install: () => run(() => api('update.install'), 'No se pudo instalar la actualización'),
  }
})
