import type { Channel, EventName, EventPayload, IpcResult, Req, Res } from './ipc/contract'

/** API expuesta por el preload en `window.zhaska`. */
export interface ZhaskaBridge {
  platform: string
  versions: { electron: string; chrome: string; node: string }
  invoke<C extends Channel>(channel: C, req: Req<C>): Promise<IpcResult<Res<C>>>
  on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void
  /**
   * Carpeta arrastrada desde el sistema: devuelve su ruta y main la acepta como elegida por el usuario
   * (solo funciona con archivos arrastrados de verdad; null si no es una carpeta).
   */
  grantDroppedFolder(file: File): Promise<string | null>
}
