import { create } from 'zustand'
import { api, errorMessage, hasBackend } from '@renderer/lib/api'
import { toast } from './ui'
import { DEFAULT_PROTECTED_PATTERNS } from '@shared/protectedFiles'

/** Nivel de autonomía del agente (referencia Forja · Agente y permisos). */
export type Autonomy = 'ask' | 'balanced' | 'autonomous'
export type ActionPolicy = 'allow' | 'ask' | 'block'
export type PermissionAction = 'read' | 'write' | 'execute' | 'install' | 'internet'

export interface Settings {
  activeModel: string
  visionModel: string
  temperature: number
  numCtx: number
  thinking: boolean
  autoVerify: boolean
  ollamaHost: string
  optimizeMemory: boolean
  language: 'es'
  uiDensity: 'comfortable' | 'compact'
  reduceMotion: boolean
  /** '' = carpeta por defecto (~/ZHASKA/proyectos) */
  projectsDir: string
  openLastProject: boolean
  onboardingDone: boolean
  composerMode: 'agent' | 'chat'
  agentMaxSteps: number
  agentProtocol: 'auto' | 'native' | 'json'
  /** Origen de las descargas de modelos */
  modelSource: 'auto' | 'ollama' | 'huggingface'
  lastProjectId: string | null
  shell: 'powershell' | 'cmd' | 'gitbash'
  terminalFontSize: number
  editorFontSize: number
  editorTabSize: number
  editorWordWrap: boolean
  editorMinimap: boolean
  autonomy: Autonomy
  permissions: Record<PermissionAction, ActionPolicy>
  protectedPatterns: string[]
  checkUpdates: boolean
  checkpointRetentionDays: number
  backupsKeep: number
  /** Modelo de embeddings de las bases de conocimiento (Fase 12) */
  embedModel: string
  /** Modelo del asistente de empresa ('' = el activo) */
  assistantModel: string
}

export const AUTONOMY_PRESETS: Record<Autonomy, Record<PermissionAction, ActionPolicy>> = {
  ask: { read: 'ask', write: 'ask', execute: 'ask', install: 'ask', internet: 'block' },
  balanced: { read: 'allow', write: 'ask', execute: 'ask', install: 'ask', internet: 'block' },
  autonomous: { read: 'allow', write: 'allow', execute: 'allow', install: 'ask', internet: 'block' },
}

export const DEFAULT_SETTINGS: Settings = {
  activeModel: 'gemma4:12b-it-qat',
  /** Modelo de visión auxiliar: 'auto' (primero instalado con visión), un nombre o 'off' */
  visionModel: 'auto',
  temperature: 0.2,
  numCtx: 32768,
  thinking: true,
  autoVerify: true,
  ollamaHost: 'http://127.0.0.1:11434',
  optimizeMemory: true,
  language: 'es',
  uiDensity: 'comfortable',
  reduceMotion: false,
  projectsDir: '',
  openLastProject: true,
  onboardingDone: false,
  composerMode: 'agent',
  agentMaxSteps: 30,
  agentProtocol: 'auto',
  modelSource: 'auto',
  lastProjectId: null,
  shell: 'powershell',
  terminalFontSize: 12,
  editorFontSize: 12.5,
  editorTabSize: 2,
  editorWordWrap: false,
  editorMinimap: false,
  autonomy: 'balanced',
  permissions: AUTONOMY_PRESETS.balanced,
  protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS],
  checkUpdates: true,
  checkpointRetentionDays: 30,
  backupsKeep: 7,
  embedModel: 'embeddinggemma',
  assistantModel: '',
}

interface SettingsStore extends Settings {
  hydrated: boolean
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  setAutonomy: (a: Autonomy) => void
  hydrate: () => Promise<void>
}

const LOCAL_KEY = 'zhaska.settings'

function persist(key: keyof Settings, value: unknown) {
  if (hasBackend) {
    api('settings.set', { key, value }).catch((e) => toast({ tone: 'error', title: 'No se pudo guardar el ajuste', description: errorMessage(e) }))
    return
  }
  try {
    const all = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') as Record<string, unknown>
    all[key] = value
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all))
  } catch {
    /* vista de navegador sin almacenamiento: solo en memoria */
  }
}

/**
 * Ajustes de la app. Fuente de verdad: tabla `settings` de SQLite (vía IPC).
 * En la vista de navegador (sin backend) se usan en memoria + localStorage.
 */
export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  hydrated: false,
  set: (key, value) => {
    set({ [key]: value } as Partial<Settings>)
    persist(key, value)
  },
  setAutonomy: (autonomy) => {
    get().set('autonomy', autonomy)
    get().set('permissions', AUTONOMY_PRESETS[autonomy])
  },
  hydrate: async () => {
    let stored: Record<string, unknown> = {}
    try {
      stored = hasBackend ? await api('settings.getAll') : (JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') as Record<string, unknown>)
    } catch {
      stored = {}
    }
    const known = Object.fromEntries(Object.entries(stored).filter(([k]) => k in DEFAULT_SETTINGS)) as Partial<Settings>
    set({ ...known, hydrated: true })
  },
}))

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  ask: 'Preguntar siempre',
  balanced: 'Equilibrado',
  autonomous: 'Autónomo',
}
