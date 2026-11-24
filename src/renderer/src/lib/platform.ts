import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ZhaskaBridge } from '@shared/bridge'

declare global {
  interface Window {
    /** Presente dentro de Electron; ausente en la vista previa de navegador (`npm run dev:web`). */
    zhaska?: ZhaskaBridge
  }
  const __APP_VERSION__: string
}

export const bridge = window.zhaska
export const inElectron = Boolean(bridge)
export const platform = bridge?.platform ?? (navigator.userAgent.includes('Mac') ? 'darwin' : 'win32')
export const isMac = platform === 'darwin'
export const MOD = isMac ? '⌘' : 'Ctrl'
export const APP_VERSION = __APP_VERSION__

/** Tecla modificadora principal pulsada (Cmd en macOS, Ctrl en Windows). */
export const isMod = (e: KeyboardEvent | ReactKeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey)
