import type { Channel, EventName, EventPayload, IpcErrorCode, Req, Res } from '@shared/ipc/contract'
import { bridge } from './platform'

export class ApiError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** true dentro de Electron. En `npm run dev:web` no hay backend y solo funciona la demostración. */
export const hasBackend = Boolean(bridge?.invoke)

/** Cliente IPC tipado: lanza ApiError con el código y el mensaje que devuelve el proceso principal. */
export async function api<C extends Channel>(channel: C, ...args: Req<C> extends undefined ? [] : [Req<C>]): Promise<Res<C>> {
  if (!bridge?.invoke) throw new ApiError('INTERNAL', 'Esta acción necesita la aplicación de escritorio (no está disponible en la vista de navegador).')
  const result = await bridge.invoke(channel, args[0] as Req<C>)
  if (!result.ok) throw new ApiError(result.error.code, result.error.message)
  return result.data
}

export function onEvent<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
  return bridge?.on ? bridge.on(event, listener) : () => {}
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
