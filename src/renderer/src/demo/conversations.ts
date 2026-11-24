import type { AttachmentKind, AttachmentMetaInfo } from '@shared/attachments'
/**
 * ⚠️ DATOS SIMULADOS (Fase 2). Conversaciones de ejemplo para visualizar el chat.
 * Desde la Fase 3 se leen de SQLite; desde la Fase 4 las respuestas las genera el modelo.
 */
import type { ToolName } from '@shared/agent/events'

/** Adjunto tal como lo muestra la interfaz (composer, mensajes, diálogo de adjuntos). */
export interface AttachmentMeta {
  id: string
  name: string
  ext: string
  size: number
  kind: AttachmentKind
  /** queued = subiéndose al almacén local; processing = extrayendo contenido */
  status: 'queued' | 'processing' | 'ready' | 'error'
  /** Vista local de una imagen antes de guardarla (o de la demostración) */
  previewUrl?: string
  /** Miniatura generada por main (data URL) */
  thumb?: string | null
  error?: string | null
  progress?: string
  meta?: AttachmentMetaInfo
  /** true = guardado en el almacén local de adjuntos (id real) */
  stored?: boolean
}

export interface ToolChipRef {
  stepId: string
  tool: ToolName
  verb: string
  target: string
  /** Resultado guardado (tareas reales ya terminadas) */
  ok?: boolean
}

export interface FileChange {
  path: string
  kind: 'create' | 'modify' | 'delete'
  additions: number
  deletions: number
}

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; lang: string; path?: string; code: string }
  | { kind: 'tools'; chips: ToolChipRef[]; taskId?: string }
  | { kind: 'changes'; changes: FileChange[]; taskId?: string }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; code: string; message: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  ts: number
  model?: string
  blocks: ChatBlock[]
  attachments?: AttachmentMeta[]
  /** Mensaje asociado a la tarea en curso del panel de actividad. */
  taskId?: string
  metrics?: { tokensPerSec: number; totalMs: number; promptTokens: number; evalTokens: number; loadMs: number } | null
}

export interface Conversation {
  id: string
  title: string
  projectId: string
  updatedAt: number
  messages: ChatMessage[]
}

const t0 = new Date(2026, 10, 22, 18, 42).getTime()

export const DEMO_CONVERSATIONS: Conversation[] = [
  {
    id: 'c1',
    title: 'Panel de ventas con gráficos',
    projectId: 'demo-tienda',
    updatedAt: Date.now(),
    messages: [
      {
        id: 'm1',
        role: 'user',
        ts: t0,
        blocks: [
          {
            kind: 'text',
            text: 'Crea un dashboard de ventas mensuales con un gráfico de barras apiladas usando los datos del Excel adjunto. Usa el estilo de @src/components/Header.tsx y añade un selector de periodo (3, 6 y 12 meses).',
          },
        ],
        attachments: [{ id: 'att1', name: 'ventas_2026.xlsx', ext: 'xlsx', size: 48_312, kind: 'sheet', status: 'ready' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        ts: t0 + 4000,
        model: 'gemma4:12b-it-qat',
        taskId: 'demo-task-1',
        blocks: [
          {
            kind: 'text',
            text: 'He revisado la estructura del proyecto y el Excel: 12 meses × 4 categorías en la hoja «Resumen». Voy a crear el componente del gráfico, integrarlo en el dashboard con un selector de periodo y añadir `recharts` como dependencia.',
          },
          {
            kind: 'tools',
            chips: [
              { stepId: 's2', tool: 'read_project_config', verb: 'Leído', target: 'package.json' },
              { stepId: 's3', tool: 'read_file', verb: 'Leído', target: 'Header.tsx' },
              { stepId: 's4', tool: 'read_attachment', verb: 'Analizado', target: 'ventas_2026.xlsx' },
              { stepId: 's6', tool: 'create_file', verb: 'Creado', target: 'SalesChart.tsx' },
              { stepId: 's7', tool: 'edit_file', verb: 'Editado', target: 'Dashboard.tsx' },
              { stepId: 's9', tool: 'inspect_errors', verb: 'Comprobado', target: 'tsc --noEmit' },
              { stepId: 's10', tool: 'install_dependencies', verb: 'Instalar', target: 'recharts@3' },
            ],
          },
          {
            kind: 'code',
            lang: 'typescript',
            path: 'src/components/SalesChart.tsx',
            code: `export function SalesChart({ data }: Props) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data}>
        {SERIES.map((s) => (
          <Bar key={s.key} dataKey={s.key} stackId="ventas" fill={s.color} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}`,
          },
          {
            kind: 'text',
            text: 'La comprobación de tipos falla porque `recharts` aún no está instalado. Necesito tu permiso para ejecutar `npm install recharts@3`.',
          },
          {
            kind: 'changes',
            changes: [
              { path: 'src/components/SalesChart.tsx', kind: 'create', additions: 37, deletions: 0 },
              { path: 'src/components/Dashboard.tsx', kind: 'modify', additions: 17, deletions: 6 },
              { path: 'src/App.tsx', kind: 'modify', additions: 8, deletions: 1 },
              { path: 'package.json', kind: 'modify', additions: 1, deletions: 0 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'c2',
    title: 'Arreglar login con JWT',
    projectId: 'demo-tienda',
    updatedAt: Date.now() - 2 * 3_600_000,
    messages: [
      { id: 'm3', role: 'user', ts: t0 - 7_200_000, blocks: [{ kind: 'text', text: 'El login devuelve 401 aunque el token es válido. ¿Puedes revisarlo?' }] },
      {
        id: 'm4',
        role: 'assistant',
        ts: t0 - 7_190_000,
        model: 'gemma4:12b-it-qat',
        blocks: [
          { kind: 'text', text: 'El middleware comparaba `exp` en milisegundos con un valor en segundos, así que todos los tokens parecían caducados. Lo he corregido y he añadido una prueba.' },
          { kind: 'changes', changes: [{ path: 'src/auth/verify.ts', kind: 'modify', additions: 3, deletions: 2 }, { path: 'src/auth/verify.test.ts', kind: 'create', additions: 24, deletions: 0 }] },
        ],
      },
    ],
  },
  {
    id: 'c3',
    title: 'Migrar estilos a Tailwind 4',
    projectId: 'demo-tienda',
    updatedAt: Date.now() - 26 * 3_600_000,
    messages: [
      { id: 'm5', role: 'user', ts: t0 - 86_400_000, blocks: [{ kind: 'text', text: '¿Qué implica migrar los estilos actuales a Tailwind 4?' }] },
      {
        id: 'm6',
        role: 'assistant',
        ts: t0 - 86_390_000,
        model: 'gemma4:e4b-it-qat',
        blocks: [{ kind: 'text', text: 'Tailwind 4 se configura desde CSS con `@theme` y ya no necesita `tailwind.config.js`. En este proyecto hay 3 archivos CSS; la migración afectaría sobre todo a `styles.css`.' }],
      },
    ],
  },
]
