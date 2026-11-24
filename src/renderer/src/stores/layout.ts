import { create } from 'zustand'
import type { PanelImperativeHandle } from 'react-resizable-panels'

export type PanelId = 'sidebar' | 'chat' | 'activity' | 'workbench' | 'explorer' | 'terminal'
export type Preset = 'agent' | 'ide' | 'full'

/** Handles imperativos registrados por el Workbench. */
export const panelHandles: Partial<Record<PanelId, PanelImperativeHandle | null>> = {}

interface LayoutStore {
  collapsed: Record<PanelId, boolean>
  preset: Preset | null
  setCollapsed: (id: PanelId, v: boolean) => void
  toggle: (id: PanelId) => void
  show: (id: PanelId) => void
  applyPreset: (p: Preset) => void
}

const PRESETS: Record<Preset, Partial<Record<PanelId, boolean>>> = {
  // Para quien no programa: conversación y actividad, sin editor.
  agent: { sidebar: false, chat: false, activity: false, workbench: true },
  // Para programar: editor y terminal protagonistas, chat al lado.
  ide: { sidebar: false, chat: false, activity: true, workbench: false, explorer: false, terminal: false },
  full: { sidebar: false, chat: false, activity: false, workbench: false, explorer: false, terminal: false },
}

export const useLayout = create<LayoutStore>((set, get) => ({
  collapsed: { sidebar: false, chat: false, activity: false, workbench: false, explorer: false, terminal: false },
  preset: 'full',
  setCollapsed: (id, v) => set({ collapsed: { ...get().collapsed, [id]: v } }),
  toggle: (id) => {
    const h = panelHandles[id]
    if (!h) return
    if (h.isCollapsed()) h.expand()
    else h.collapse()
    set({ preset: null })
  },
  show: (id) => {
    const h = panelHandles[id]
    if (h?.isCollapsed()) h.expand()
  },
  applyPreset: (p) => {
    for (const [id, collapse] of Object.entries(PRESETS[p]) as [PanelId, boolean][]) {
      const h = panelHandles[id]
      if (!h) continue
      if (collapse && !h.isCollapsed()) h.collapse()
      if (!collapse && h.isCollapsed()) h.expand()
    }
    set({ preset: p })
  },
}))
