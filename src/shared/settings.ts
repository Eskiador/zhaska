import { z } from 'zod'
import { PROTECTED_PATTERN_RE } from './protectedFiles'

/**
 * Lista blanca de ajustes con su tipo (auditoría de IPC, Fase 9). `settings.set` rechaza cualquier clave
 * que no esté aquí o un valor que no cumpla su esquema: la interfaz no puede guardar datos arbitrarios
 * que luego lean main o el agente.
 */
const Policy = z.enum(['allow', 'ask', 'block'])

/** Solo un Ollama de este equipo: el contenido de tus proyectos nunca sale hacia otro servidor sin una función explícita para ello. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname) && !u.username && !u.password
  } catch {
    return false
  }
}

export const SETTINGS_SCHEMA = {
  activeModel: z.string().max(200),
  visionModel: z.string().max(200),
  temperature: z.number().min(0).max(2),
  numCtx: z.number().int().min(2048).max(262_144),
  thinking: z.boolean(),
  autoVerify: z.boolean(),
  ollamaHost: z.string().max(300).refine(isLoopbackUrl, 'Ollama debe estar en este equipo (http://127.0.0.1:…)'),
  optimizeMemory: z.boolean(),
  language: z.literal('es'),
  uiDensity: z.enum(['comfortable', 'compact']),
  reduceMotion: z.boolean(),
  /** '' = carpeta por defecto; si no, una carpeta elegida en el selector (se comprueba en main) */
  projectsDir: z.string().max(1024),
  openLastProject: z.boolean(),
  onboardingDone: z.boolean(),
  composerMode: z.enum(['agent', 'chat']),
  agentMaxSteps: z.number().int().min(1).max(200),
  agentProtocol: z.enum(['auto', 'native', 'json']),
  modelSource: z.enum(['auto', 'ollama', 'huggingface']),
  lastProjectId: z.string().max(100).nullable(),
  shell: z.enum(['powershell', 'cmd', 'gitbash']),
  terminalFontSize: z.number().min(8).max(32),
  editorFontSize: z.number().min(8).max(32),
  editorTabSize: z.number().int().min(1).max(8),
  editorWordWrap: z.boolean(),
  editorMinimap: z.boolean(),
  autonomy: z.enum(['ask', 'balanced', 'autonomous']),
  permissions: z.object({ read: Policy, write: Policy, execute: Policy, install: Policy, internet: Policy }),
  protectedPatterns: z.array(z.string().regex(PROTECTED_PATTERN_RE, 'Patrón no válido')).max(100),
  checkUpdates: z.boolean(),
  checkpointRetentionDays: z.number().int().min(1).max(3650),
  backupsKeep: z.number().int().min(1).max(100),
} as const

export type SettingKey = keyof typeof SETTINGS_SCHEMA

export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(SETTINGS_SCHEMA, k)
