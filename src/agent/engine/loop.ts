import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent, ToolName } from '@shared/agent/events'
import type { ChatTurn, ModelPhase, AttachmentRef } from '@shared/agent/host'
import { agentSystemPrompt } from '@shared/agent/agentPrompt'
import type { OllamaChatMessage, ChatMetrics } from '@shared/ollama/client'
import { PathGuard } from '@core/security/pathGuard'
import { OutsideReads } from '@core/security/outsideReads'
import { runCommand } from '@core/commands/runner'
import { OllamaProvider, runStep } from '../providers/ollama'
import { TOOLS, toolSpecs, type PermissionAction, type PermissionNeed, type ToolContext, type ToolDef, type ToolResult } from '../tools/registry'
import { modelProfile, NON_CORE_TOOLS, type ModelProfile, type PromptStyle } from '@shared/agent/modelProfiles'
import { jsonProtocol, nativeProtocol, type ParsedCall, type ToolProtocol } from './protocols'
import { BlobStore, ChangeTracker, type RecordedChange } from '../workspace/changes'
import { detectProject, projectTree } from '../workspace/explore'

export type Policy = 'allow' | 'ask' | 'block'
export type Decision = 'allow_once' | 'allow_always' | 'deny'

export interface AgentTaskSpec {
  taskId: string
  model: string
  root: string
  projectName: string
  userMessage: string
  history: ChatTurn[]
  numCtx: number
  temperature: number
  think: boolean
  maxSteps: number
  protocol: 'auto' | 'native' | 'json'
  autonomy: 'ask' | 'balanced' | 'autonomous'
  permissions: Record<PermissionAction, Policy>
  /** Reglas "siempre en este proyecto" ya concedidas */
  rules: { action: PermissionAction; pattern: string }[]
  protectedPatterns: string[]
  autoVerify: boolean
  shell: 'powershell' | 'cmd' | 'gitbash' | 'posix'
  blobDir: string
  /** Adjuntos de la conversación, legibles con read_attachment (Fase 8) */
  attachments?: AttachmentRef[]
  /** Texto de los adjuntos de este mensaje (preparado por main) */
  attachmentContext?: string
  /** Imágenes de este mensaje (solo modelos con visión) */
  images?: string[]
  /** Nombres de los adjuntos de este mensaje (para el panel de actividad) */
  attachmentNames?: string[]
  /** Carpetas fuera del proyecto que el usuario autorizó (solo lectura, Fase 9) */
  externalDirs?: string[]
  /** Carpetas que nunca se leen (datos de ZHASKA, credenciales) */
  blockedDirs?: string[]
  /** Forzar el estilo de prompt (por defecto, según el modelo: modelProfiles.ts) */
  promptStyle?: PromptStyle
}

/**
 * Herramientas que se ofrecen en esta tarea (Fase 11): no se ofrecen las que el usuario bloqueó ni las que no
 * aplican (read_attachment sin adjuntos); los perfiles «core» (modelos pequeños) no reciben las de planificación.
 */
/** Resumen de los argumentos de una herramienta para los mensajes de error («path (obligatorio): …»). */
function describeArgs(tool: ToolDef): string {
  const spec = toolSpecs([tool])[0]!.function.parameters as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
  return Object.entries(spec.properties ?? {})
    .map(([k, v]) => `${k}${spec.required?.includes(k) ? ' (obligatorio)' : ''}${v.description ? `: ${v.description}` : ''}`)
    .join('; ')
}

export function offeredTools(spec: Pick<AgentTaskSpec, 'permissions' | 'attachments'>, profile: ModelProfile): ToolDef[] {
  const blocked = (a: PermissionAction) => spec.permissions[a] === 'block'
  return TOOLS.filter((t) => {
    if (t.name === 'read_attachment' && !spec.attachments?.length) return false
    if (t.name === 'install_dependencies' && blocked('install')) return false
    if (['create_file', 'edit_file', 'write_file', 'delete_file'].includes(t.name) && blocked('write')) return false
    if (['execute_command', 'run_tests', 'inspect_errors'].includes(t.name) && blocked('execute')) return false
    if (profile.tools === 'core' && NON_CORE_TOOLS.has(t.name)) return false
    return true
  })
}

type EventNoTs = AgentEvent extends infer E ? (E extends { ts: number } ? Omit<E, 'ts'> : never) : never

export interface LoopDeps {
  provider: OllamaProvider
  emit: (e: EventNoTs) => void
  /** Texto para el chat (narración del agente) */
  text: (delta: string) => void
  askApproval: (req: { requestId: string; stepId: string; tool: ToolName; command: string; detail: string; risk: 'read' | 'write' | 'destructive' | 'execute' }) => Promise<Decision>
  onChange: (c: RecordedChange) => void
  onRule: (rule: { action: PermissionAction; pattern: string }) => void
  /** Si la tarea está en pausa, espera a que se reanude (o se cancele) */
  waitIfPaused?: (signal: AbortSignal) => Promise<void>
}

export interface LoopResult {
  status: 'completed' | 'failed' | 'cancelled'
  text: string
  steps: { stepId: string; tool: ToolName; title: string; target?: string; ok: boolean; diff?: { additions: number; deletions: number } }[]
  error?: string
  metrics: { promptTokens: number; evalTokens: number; steps: number; lastTokensPerSec: number }
}

/** «Voy a añadir…», «A continuación crearé…»: anuncia trabajo en lugar de hacerlo */
const ANNOUNCES_WORK = /\b(voy a|vamos a|procedo a|proceder[eé]|a continuaci[oó]n,? (voy|a[nñ]adir|crear|modificar|editar|implementar)|ahora (voy|a[nñ]adir[eé]|crear[eé]|modificar[eé]|implementar[eé])|(a[nñ]adir|crear|modificar|editar|implementar|actualizar)[eé] )/i

const MAX_INVALID = 3
const MAX_REPEAT = 3
/** Fallos seguidos de herramientas (aunque cambien los argumentos) antes de parar */
const MAX_FAILURES = 5
const MAX_RESULT_CHARS = 12_000
const MAX_MENTION_CHARS = 8_000

/** Decide si una acción se permite, se pregunta o se bloquea (ARCHITECTURE §9.2 con los niveles de la referencia). */
export function decide(need: PermissionNeed, spec: Pick<AgentTaskSpec, 'permissions' | 'autonomy' | 'rules'>): 'allow' | 'ask' | 'deny' {
  const policy = spec.permissions[need.action]
  const risky = need.assessment?.level === 'dangerous' || need.assessment?.outsideProject || !!need.protectedPath || !!need.outsidePath
  if (policy === 'block') return 'deny'
  if (risky) return 'ask' // siempre con confirmación, sea cual sea el nivel
  if (need.alwaysAsk) return 'ask'
  const pattern = need.command ?? '*'
  if (spec.rules.some((r) => r.action === need.action && (r.pattern === '*' || r.pattern === pattern))) return 'allow'
  if (policy === 'allow') return 'allow'
  if (spec.autonomy !== 'ask' && need.action === 'execute' && need.assessment?.level === 'safe') return 'allow'
  if (spec.autonomy !== 'ask' && need.action === 'read') return 'allow'
  return 'ask'
}

const RISK: Record<PermissionAction, 'read' | 'write' | 'destructive' | 'execute'> = { read: 'read', write: 'write', execute: 'execute', install: 'execute', internet: 'execute' }

export class AgentLoop {
  private protocol!: ToolProtocol
  private messages: OllamaChatMessage[] = []
  private guard: PathGuard
  private outside: OutsideReads
  private profile: ModelProfile
  private tools: ToolDef[]
  /** Subida puntual de temperatura tras una repetición (se aplica a la siguiente respuesta) */
  private tempBoost = 0
  /** Último archivo leído con read_file (para edit_file sin path) */
  private lastRead: string | null = null
  private changes: ChangeTracker
  private wroteSinceCheck = false
  private verifyRounds = 0
  private steps: LoopResult['steps'] = []
  private totals = { promptTokens: 0, evalTokens: 0, lastTokensPerSec: 0 }
  private transcript = ''

  constructor(
    private readonly spec: AgentTaskSpec,
    private readonly deps: LoopDeps,
  ) {
    this.guard = new PathGuard(spec.root)
    this.profile = modelProfile(spec.model, spec.promptStyle)
    this.tools = offeredTools(spec, this.profile)
    this.outside = new OutsideReads(spec.externalDirs ?? [], { blocked: spec.blockedDirs ?? [] })
    this.changes = new ChangeTracker(new BlobStore(spec.blobDir), (c) => deps.onChange(c))
  }

  private say(text: string) {
    if (!text) return
    const chunk = this.transcript ? `\n\n${text}` : text
    this.transcript += chunk
    this.deps.text(chunk)
  }

  async run(signal: AbortSignal): Promise<LoopResult> {
    const { spec, deps } = this
    deps.emit({ type: 'task.started', taskId: spec.taskId, model: spec.model })
    try {
      const caps = await deps.provider.capabilities(spec.model)
      this.protocol = spec.protocol === 'json' || (spec.protocol === 'auto' && !caps.tools) ? jsonProtocol : nativeProtocol
      const first: OllamaChatMessage = { role: 'user', content: [await this.withMentions(spec.userMessage), spec.attachmentContext].filter(Boolean).join('\n\n') }
      if (spec.images?.length) first.images = spec.images
      this.messages = [{ role: 'system', content: await this.systemPrompt() }, ...spec.history.map((t) => ({ role: t.role, content: t.content }) as OllamaChatMessage), first]
      if (spec.attachmentNames?.length) {
        // Paso real: el contenido de los adjuntos de este mensaje entra en el contexto del modelo
        const stepId = randomUUID()
        const n = spec.attachmentNames.length
        deps.emit({ type: 'step.started', stepId, tool: 'read_attachment', title: 'Adjuntos en el contexto', target: n === 1 ? spec.attachmentNames[0] : `${n} adjuntos` })
        deps.emit({ type: 'step.completed', stepId, summary: [spec.attachmentNames.join(', '), spec.images?.length ? `${spec.images.length} imagen${spec.images.length === 1 ? '' : 'es'} enviada${spec.images.length === 1 ? '' : 's'} al modelo` : ''].filter(Boolean).join(' · ') })
      }

      let invalid = 0
      let failures = 0
      let emptyRetries = 0
      let announceNudged = false
      const seen = new Map<string, number>()
      for (let step = 1; step <= spec.maxSteps; step++) {
        if (signal.aborted) return this.finish('cancelled')
        await this.deps.waitIfPaused?.(signal)
        if (signal.aborted) return this.finish('cancelled')
        this.compact()
        let streamed = false
        const temperature = Math.min(spec.temperature, this.profile.maxTemperature) + this.tempBoost
        this.tempBoost = 0
        const r = await runStep(deps.provider, { model: spec.model, messages: this.messages, ...this.protocol.request(this.tools), numCtx: spec.numCtx, temperature, think: spec.think }, signal, {
          phase: (p: ModelPhase) => deps.emit({ type: 'model.state', state: p === 'loading' ? 'prompt' : p, tokensPerSec: this.totals.lastTokensPerSec || undefined }),
          delta: this.protocol.streamsText
            ? (t) => {
                if (!streamed && this.transcript) this.deps.text('\n\n')
                streamed = true
                this.deps.text(t)
              }
            : undefined,
        })
        this.account(r.metrics)
        const parsed = this.protocol.parse(r.content, r.toolCalls)
        if (this.protocol.streamsText) this.transcript += (this.transcript && r.content ? '\n\n' : '') + r.content
        else if (parsed.text) this.say(parsed.text)

        if (parsed.parseError) {
          if (++invalid > MAX_INVALID) return this.finish('failed', 'El modelo no respondió en el formato esperado varias veces seguidas.')
          this.messages.push(this.protocol.assistantTurn(r.content, []), { role: 'user', content: `Error de formato: ${parsed.parseError}` })
          continue
        }

        if (parsed.calls.length === 0) {
          // Respuesta vacía (ni texto ni herramientas): no es un final; se le pide que siga (Fase 11)
          if (!parsed.text.trim() && emptyRetries < 2) {
            emptyRetries++
            this.messages.push(this.protocol.assistantTurn(r.content, []), { role: 'user', content: 'Tu respuesta llegó vacía. Continúa con la tarea: usa la siguiente herramienta o, si ya has terminado, responde con un resumen de lo que hiciste.' })
            continue
          }
          // Anuncia lo que va a hacer pero no ha cambiado nada: se le recuerda una vez que lo haga con las herramientas
          if (!announceNudged && !this.steps.some((st) => st.ok && st.diff) && ANNOUNCES_WORK.test(parsed.text)) {
            announceNudged = true
            this.messages.push(this.protocol.assistantTurn(r.content, []), { role: 'user', content: 'Has explicado lo que vas a hacer, pero todavía no lo has hecho. Hazlo ahora con las herramientas; si no puedes, explica qué te lo impide.' })
            continue
          }
          // Respuesta final. Verificación automática si hubo cambios sin comprobar.
          if (spec.autoVerify && this.wroteSinceCheck && this.verifyRounds < 2 && this.tools.some((t) => t.name === 'inspect_errors')) {
            this.verifyRounds++
            const check = await this.execute({ name: 'inspect_errors', args: {} }, signal)
            if (!check.ok && check.output.includes('errores')) {
              this.messages.push(this.protocol.assistantTurn(r.content, []), { role: 'user', content: `La comprobación automática encontró errores tras tus cambios. Corrígelos antes de terminar:\n${check.output}` })
              continue
            }
          }
          if (!parsed.text && !this.transcript) this.say('He terminado.')
          return this.finish('completed')
        }

        this.messages.push(this.protocol.assistantTurn(r.content, parsed.calls))
        for (const call of parsed.calls) {
          if (signal.aborted) return this.finish('cancelled')
          await this.deps.waitIfPaused?.(signal)
          if (signal.aborted) return this.finish('cancelled')
          // Repeticiones: la misma llamada sin que nada haya cambiado entre medias. Releer un archivo o volver a
          // pasar las pruebas DESPUÉS de editar es normal (el contador se reinicia con cada cambio, Fase 11).
          const key = `${call.name}:${JSON.stringify(call.args)}`
          const n = (seen.get(key) ?? 0) + 1
          seen.set(key, n)
          if (n >= MAX_REPEAT + 2) return this.finish('failed', `Se detuvo la tarea: el agente repitió la misma acción (${call.name}) ${n} veces sin avanzar.`)
          if (n >= MAX_REPEAT) {
            const hintFor = call.name === 'edit_file' ? ' Para edit_file: indica path, copia old_string exacto de read_file y, para añadir al final del archivo, usa old_string vacío ("").' : ''
            this.messages.push(
              this.protocol.resultTurn(call, `Ya has hecho exactamente esta llamada ${n - 1} veces y nada ha cambiado desde entonces, así que el resultado sería el mismo. Haz otra cosa: usa otra herramienta, cambia los argumentos o termina explicando qué te falta.${hintFor}`),
            )
            // Con temperatura baja el modelo tiende a repetir lo mismo: la siguiente respuesta varía un poco más
            this.tempBoost = 0.5
            continue
          }
          const res = await this.execute(call, signal)
          if (res.ok && res.diff) seen.clear()
          if (res.invalid) invalid++
          else invalid = 0
          failures = res.ok ? 0 : failures + 1
          if (invalid > MAX_INVALID) return this.finish('failed', 'El modelo hizo varias llamadas no válidas seguidas.')
          if (failures >= MAX_FAILURES) return this.finish('failed', `Se detuvo la tarea tras ${failures} acciones fallidas seguidas. Revisa el último error en el panel de actividad.`)
          this.messages.push(this.protocol.resultTurn(call, clipResult(res.output)))
        }
      }
      return this.finish('failed', `Se alcanzó el límite de ${spec.maxSteps} pasos. Puedes pedirle que continúe.`)
    } catch (e) {
      if (signal.aborted) return this.finish('cancelled')
      return this.finish('failed', (e as Error)?.message ?? String(e))
    }
  }

  /** Valida, pide permiso si hace falta y ejecuta una llamada. Emite los eventos reales del panel. */
  private async execute(call: ParsedCall, signal: AbortSignal): Promise<ToolResult & { invalid?: boolean }> {
    const tool = this.tools.find((t) => t.name === call.name)
    if (!tool) return { ok: false, invalid: true, output: `Error: la herramienta "${call.name}" no existe o no está disponible en esta tarea. Disponibles: ${this.tools.map((t) => t.name).join(', ')}.` }
    // edit_file sin «path»: se usa el último archivo leído (Fase 11: Gemma 4 lo olvida aunque el error se lo diga).
    // Solo se aplica si old_string está en ese archivo, y el cambio queda en el diff como cualquier otro.
    let inferredPath: string | null = null
    if (tool.name === 'edit_file' && this.lastRead && call.args && typeof call.args === 'object' && !(call.args as { path?: unknown }).path) {
      call = { ...call, args: { ...(call.args as object), path: this.lastRead } }
      inferredPath = this.lastRead
    }
    const parsed = tool.schema.safeParse(call.args)
    if (!parsed.success) {
      // Mensajes accionables (Fase 11): qué falta exactamente y qué argumentos admite la herramienta
      const issues = parsed.error.issues
        .map((i) => {
          const where = i.path.join('.') || 'args'
          const missing = i.code === 'invalid_type' && /received undefined/i.test(i.message)
          return missing ? `falta el argumento obligatorio «${where}»` : `${where}: ${i.message}`
        })
        .join('; ')
      return { ok: false, invalid: true, output: `Error: argumentos no válidos para ${tool.name}: ${issues}.\nArgumentos de ${tool.name}: ${describeArgs(tool)}\nCorrige la llamada; no la repitas igual.` }
    }
    const args = parsed.data
    const stepId = randomUUID()
    const { title, target } = tool.describe(args)
    const ctx = this.toolContext(stepId, signal)
    this.deps.emit({ type: 'step.started', stepId, tool: tool.name, title, target })

    let need: PermissionNeed
    try {
      need = tool.permission(args, ctx)
    } catch (e) {
      const msg = (e as Error).message
      this.deps.emit({ type: 'step.failed', stepId, error: msg })
      this.steps.push({ stepId, tool: tool.name, title, target, ok: false })
      return { ok: false, output: `Error: ${msg}` }
    }
    const verdict = decide(need, this.spec)
    if (verdict === 'deny') {
      this.deps.emit({ type: 'step.cancelled', stepId })
      this.steps.push({ stepId, tool: tool.name, title, target, ok: false })
      return { ok: false, output: `Bloqueado por los ajustes del usuario (permiso "${need.action}" bloqueado). No lo intentes de nuevo; explica al usuario qué necesitarías.` }
    }
    if (verdict === 'ask') {
      const requestId = randomUUID()
      this.deps.emit({ type: 'model.state', state: 'waiting_approval' })
      const detail = [
        need.detail,
        need.protectedPath ? `Archivo protegido (${need.protectedPath})` : '',
        need.outsidePath ? 'Fuera del proyecto: solo se aprueba esta ruta' : '',
        need.assessment?.level === 'dangerous' ? 'Comando potencialmente peligroso' : '',
        need.alwaysAsk && need.action === 'execute' ? 'Borra archivos sin instantánea para deshacerlo' : '',
      ]
        .filter(Boolean)
        .join(' · ')
      // Lo que pregunta siempre no puede convertirse en una regla «Siempre aquí» (y la interfaz no ofrece el botón)
      const canAlways = !need.assessment?.outsideProject && need.assessment?.level !== 'dangerous' && !need.protectedPath && !need.outsidePath && !need.alwaysAsk
      this.deps.emit({ type: 'approval.requested', requestId, stepId, tool: tool.name, command: need.command ?? target ?? title, detail, risk: need.alwaysAsk ? 'destructive' : RISK[need.action], canAlways })
      const decision = await Promise.race([this.deps.askApproval({ requestId, stepId, tool: tool.name, command: need.command ?? target ?? title, detail, risk: RISK[need.action] }), abortPromise(signal)])
      this.deps.emit({ type: 'approval.resolved', requestId, decision: decision ?? 'deny' })
      if (!decision || decision === 'deny') {
        this.deps.emit({ type: 'step.cancelled', stepId })
        this.steps.push({ stepId, tool: tool.name, title, target, ok: false })
        if (signal.aborted) return { ok: false, output: 'Cancelado.' }
        return { ok: false, output: 'El usuario denegó esta acción. No la repitas; busca otra forma o explica qué haría falta.' }
      }
      if (need.outsidePath) this.outside.approve(need.outsidePath)
      if (decision === 'allow_always' && canAlways) {
        const rule = { action: need.action, pattern: need.command ?? '*' }
        this.spec.rules.push(rule)
        this.deps.onRule(rule)
      }
      this.deps.emit({ type: 'model.state', state: 'generating' })
    }

    try {
      const res = await tool.execute(args, ctx)
      if (tool.name === 'read_file' && res.ok) this.lastRead = (args as { path: string }).path
      if (inferredPath) res.output = `(Sin «path»: se usó el último archivo leído, ${inferredPath}. Indica siempre path.)\n${res.output}`
      if (res.diff) this.wroteSinceCheck = true
      if (tool.name === 'inspect_errors' && res.ok) this.wroteSinceCheck = false
      if (res.ok) this.deps.emit({ type: 'step.completed', stepId, summary: res.summary, diff: res.diff })
      else this.deps.emit({ type: 'step.failed', stepId, error: res.output.split('\n').find((l) => l.trim())?.slice(0, 200) ?? 'Error' })
      this.steps.push({ stepId, tool: tool.name, title, target, ok: res.ok, diff: res.diff })
      return res
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      this.deps.emit({ type: 'step.failed', stepId, error: msg })
      this.steps.push({ stepId, tool: tool.name, title, target, ok: false })
      return { ok: false, output: `Error: ${msg}` }
    }
  }

  private toolContext(stepId: string, signal: AbortSignal): ToolContext {
    return {
      root: this.spec.root,
      guard: this.guard,
      signal,
      changes: this.changes,
      protectedPatterns: this.spec.protectedPatterns,
      attachments: this.spec.attachments ?? [],
      outside: this.outside,
      output: (line) => this.deps.emit({ type: 'step.output', stepId, chunk: line }),
      plan: (items) => this.deps.emit({ type: 'plan.updated', items }),
      run: (s) => {
        this.deps.emit({ type: 'step.output', stepId, chunk: `> ${s.command ?? [s.file, ...(s.args ?? [])].join(' ')}` })
        return runCommand({ cwd: this.spec.root, shell: this.spec.shell, timeoutMs: s.timeoutMs, signal, command: s.command, file: s.file, args: s.args, onOutput: (l) => this.deps.emit({ type: 'step.output', stepId, chunk: l }) })
      },
    }
  }

  private async systemPrompt(): Promise<string> {
    const [tree, info, guide] = await Promise.all([
      projectTree(this.guard, '', 2, 120).catch(() => '(no disponible)'),
      detectProject(this.spec.root).catch(() => null),
      readFile(path.join(this.spec.root, 'ZHASKA.md'), 'utf8').then(
        (s) => s.slice(0, 4000),
        () => null,
      ),
    ])
    return agentSystemPrompt({
      projectName: this.spec.projectName,
      tree,
      config: info?.summary ?? '(no disponible)',
      guide,
      protocol: this.protocol.instructions(this.tools),
      os: `${os.type()} · shell ${this.spec.shell === 'posix' ? (process.env['SHELL'] ?? 'sh') : this.spec.shell}`,
      externalDirs: this.outside.dirs,
      style: this.profile.style,
      tools: this.tools.map((t) => t.name),
    })
  }

  /** Incluye el contenido de los archivos mencionados con @ruta (máx. 3). */
  private async withMentions(text: string): Promise<string> {
    const mentions = [...new Set([...text.matchAll(/@([\w./-]+\.[\w]+)/g)].map((m) => m[1]!))].slice(0, 3)
    const parts: string[] = [text]
    for (const rel of mentions) {
      try {
        const content = await readFile(this.guard.resolve(rel), 'utf8')
        parts.push(`\nContenido de @${rel}:\n\`\`\`\n${content.slice(0, MAX_MENTION_CHARS)}${content.length > MAX_MENTION_CHARS ? '\n… (recortado)' : ''}\n\`\`\``)
      } catch {
        /* mención a algo que no existe: el modelo lo verá en el texto */
      }
    }
    return parts.join('\n')
  }

  /** Compactación: si el contexto se acerca al límite, se resumen los resultados de herramientas antiguos. */
  private compact() {
    const chars = this.messages.reduce((a, m) => a + m.content.length, 0)
    if (chars / 3.2 < this.spec.numCtx * 0.75) return
    const keepFrom = Math.max(2, this.messages.length - 6)
    this.messages = this.messages.map((m, i) => {
      if (i === 0 || i >= keepFrom || m.content.length < 400) return m
      if (m.role === 'tool' || (m.role === 'user' && m.content.startsWith('Resultado de '))) return { ...m, content: `[resultado antiguo omitido para ahorrar contexto: ${m.content.split('\n')[0]!.slice(0, 120)}]` }
      return m
    })
  }

  private account(m: ChatMetrics) {
    this.totals.promptTokens = m.promptTokens
    this.totals.evalTokens += m.evalTokens
    if (m.tokensPerSec) this.totals.lastTokensPerSec = Math.round(m.tokensPerSec * 10) / 10
    this.deps.emit({ type: 'metrics', tokens: this.totals.promptTokens + this.totals.evalTokens, contextUsed: Math.min(1, m.promptTokens / this.spec.numCtx) })
  }

  private finish(status: LoopResult['status'], error?: string): LoopResult {
    if (error && status === 'failed') this.say(`⚠️ ${error}`)
    this.deps.emit({ type: 'model.state', state: 'idle' })
    if (status === 'completed') this.deps.emit({ type: 'task.completed', summary: summarize(this.steps) })
    else if (status === 'cancelled') this.deps.emit({ type: 'task.cancelled' })
    else this.deps.emit({ type: 'task.failed', error: error ?? 'Error' })
    return { status, text: this.transcript.trim(), steps: this.steps, error, metrics: { ...this.totals, steps: this.steps.length } }
  }
}

function summarize(steps: LoopResult['steps']): string {
  const changed = steps.filter((s) => s.ok && s.diff).length
  return changed ? `Tarea completada · ${changed} archivo${changed > 1 ? 's' : ''} modificado${changed > 1 ? 's' : ''}` : 'Tarea completada'
}

function clipResult(s: string) {
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n… (resultado recortado)` : s
}

function abortPromise(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null)
    else signal.addEventListener('abort', () => resolve(null), { once: true })
  })
}
