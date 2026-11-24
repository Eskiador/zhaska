import { create } from 'zustand'
import type { ReactNode } from 'react'

export type DialogId = 'settings' | 'models' | 'palette' | 'attachments' | 'newProject' | null
export type SettingsSection = 'general' | 'appearance' | 'editor' | 'shortcuts' | 'models' | 'ollama' | 'agent' | 'context' | 'privacy' | 'about'

export interface MenuItem {
  id: string
  label?: string
  icon?: ReactNode
  shortcut?: string
  hint?: string
  danger?: boolean
  checked?: boolean
  lockedPhase?: number
  separator?: boolean
  onSelect?: () => void
}

export interface MenuState {
  items: MenuItem[]
  x: number
  y: number
  /** Ancho mínimo (p. ej. el del disparador) */
  minWidth?: number
}

export interface Toast {
  id: number
  title: string
  description?: string
  tone: 'info' | 'success' | 'error' | 'locked'
}

interface UIState {
  dialog: DialogId
  settingsSection: SettingsSection
  onboarding: boolean
  menu: MenuState | null
  toasts: Toast[]
  openDialog: (d: Exclude<DialogId, null>, section?: SettingsSection) => void
  closeDialog: () => void
  setOnboarding: (v: boolean) => void
  openMenu: (m: MenuState) => void
  closeMenu: () => void
  toast: (t: Omit<Toast, 'id' | 'tone'> & { tone?: Toast['tone'] }) => void
  dismissToast: (id: number) => void
}

let toastSeq = 0

export const useUI = create<UIState>((set, get) => ({
  dialog: null,
  settingsSection: 'general',
  onboarding: false,
  menu: null,
  toasts: [],
  openDialog: (dialog, section) => set({ dialog, settingsSection: section ?? get().settingsSection, menu: null }),
  closeDialog: () => set({ dialog: null }),
  setOnboarding: (onboarding) => set({ onboarding, dialog: null }),
  openMenu: (menu) => set({ menu }),
  closeMenu: () => set({ menu: null }),
  toast: ({ tone = 'info', ...t }) => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts.slice(-2), { id, tone, ...t }] })
    if (tone !== 'error') setTimeout(() => get().dismissToast(id), 4000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export const toast = (t: Parameters<UIState['toast']>[0]) => useUI.getState().toast(t)

/** Aviso estándar al pulsar algo que llega en una fase posterior. */
export function notifyLocked(phase: number, what: string) {
  toast({ tone: 'locked', title: `${what}: Fase ${phase}`, description: 'Esta función todavía no está implementada. Ver ROADMAP.md.' })
}
