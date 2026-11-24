import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { contract, type Channel, type IpcResult, type Req, type Res } from '@shared/ipc/contract'
import { AppError } from '@core/errors'

const devOrigin = (() => {
  const url = process.env['ELECTRON_RENDERER_URL']
  try {
    return !app.isPackaged && url ? new URL(url).origin : null
  } catch {
    return null
  }
})()

/** Solo la UI propia (app://zhaska o el servidor de desarrollo) puede llamar al IPC. */
export function trustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  if (!url) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'app:' && u.host === 'zhaska') || (devOrigin !== null && u.origin === devOrigin)
  } catch {
    return false
  }
}

type Handler<C extends Channel> = (req: z.output<(typeof contract)[C]['req']>, event: IpcMainInvokeEvent) => Res<C> | Promise<Res<C>>

/**
 * Registra un canal: valida el origen y la petición con zod, ejecuta y devuelve `IpcResult`.
 * En desarrollo también valida la respuesta para detectar desajustes con el contrato.
 */
export function handle<C extends Channel>(channel: C, fn: Handler<C>): void {
  const spec = contract[channel]
  ipcMain.handle(channel, async (event, raw: Req<C>): Promise<IpcResult<Res<C>>> => {
    if (!trustedSender(event)) return { ok: false, error: { code: 'FORBIDDEN', message: 'Origen no autorizado' } }
    const parsed = spec.req.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_INPUT', message: z.prettifyError(parsed.error) } }
    try {
      const data = await fn(parsed.data as never, event)
      if (!app.isPackaged) {
        const check = spec.res.safeParse(data)
        if (!check.success) console.error(`[ipc] respuesta de ${channel} no cumple el contrato:\n${z.prettifyError(check.error)}`)
      }
      return { ok: true, data }
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message } }
      console.error(`[ipc] ${channel}`, e)
      return { ok: false, error: { code: 'INTERNAL', message: (e as Error)?.message ?? String(e) } }
    }
  })
}
