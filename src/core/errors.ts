import type { IpcErrorCode } from '@shared/ipc/contract'

/** Error de dominio con código estable: viaja al renderer como `{ ok: false, error }`. */
export class AppError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/** Traduce errores de Node (ENOENT, EEXIST…) a errores de dominio con mensajes en español. */
export function fromNodeError(e: unknown, what: string): AppError {
  if (e instanceof AppError) return e
  const code = (e as NodeJS.ErrnoException)?.code
  switch (code) {
    case 'ENOENT':
      return new AppError('NOT_FOUND', `${what}: no existe`)
    case 'EEXIST':
    case 'ENOTEMPTY':
      return new AppError('EXISTS', `${what}: ya existe`)
    case 'EACCES':
    case 'EPERM':
      return new AppError('IO', `${what}: permiso denegado por el sistema`)
    case 'EBUSY':
      return new AppError('IO', `${what}: el archivo está en uso por otro programa`)
    case 'ENOTDIR':
      return new AppError('IO', `${what}: no es una carpeta`)
    case 'EISDIR':
      return new AppError('IO', `${what}: es una carpeta`)
    default:
      return new AppError('IO', `${what}: ${(e as Error)?.message ?? String(e)}`)
  }
}
