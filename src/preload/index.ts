import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ZhaskaBridge } from '@shared/bridge'
import { CHANNELS, EVENTS } from '@shared/ipc/channels'

const allowedChannels = new Set<string>(CHANNELS)
const allowedEvents = new Set<string>(EVENTS)

/**
 * Puente mínimo y cerrado: solo los canales del contrato. Nunca se expone `ipcRenderer` ni Node.
 * La validación real de cada petición ocurre en el proceso principal.
 */
const bridge: ZhaskaBridge = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
  },
  invoke: (channel, req) => {
    if (!allowedChannels.has(channel)) return Promise.reject(new Error(`Canal IPC no permitido: ${String(channel)}`))
    return ipcRenderer.invoke(channel, req)
  },
  on: (event, listener) => {
    if (!allowedEvents.has(event)) throw new Error(`Evento IPC no permitido: ${String(event)}`)
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },
  // Carpeta arrastrada a la ventana: main la registra como elegida por el usuario (canal exclusivo del preload)
  grantDroppedFolder: async (file) => {
    const path = webUtils.getPathForFile(file)
    if (!path) return null
    return (await ipcRenderer.invoke('paths.grantDropped', { path })) as string | null
  },
}

contextBridge.exposeInMainWorld('zhaska', bridge)
