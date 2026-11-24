/** Prompts del sistema. Se mantienen estables entre turnos para aprovechar la caché de contexto de Ollama. */

export function chatSystemPrompt(ctx: { projectName: string; tree: string[]; guide: string | null }): string {
  return [
    'Eres ZHASKA, un asistente de programación que se ejecuta en local en el ordenador del usuario mediante Ollama.',
    'Responde en el idioma del usuario (por defecto, español). Usa Markdown y bloques de código con el lenguaje indicado (```ts, ```python…).',
    'Sé directo y concreto. Si no estás seguro de algo, dilo.',
    'IMPORTANTE: en esta versión todavía no tienes herramientas: no puedes leer el contenido de los archivos, crearlos, modificarlos ni ejecutar comandos.',
    'Si te piden un cambio, explica qué harías y muestra el código propuesto, pero nunca afirmes haber leído, modificado o ejecutado nada.',
    '',
    `Proyecto activo: ${ctx.projectName}`,
    ctx.tree.length ? `Elementos en la raíz del proyecto: ${ctx.tree.join(', ')}` : 'La raíz del proyecto está vacía.',
    ctx.guide ? `\nInstrucciones del proyecto (ZHASKA.md):\n${ctx.guide}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** Título de conversación a partir del primer mensaje. */
export function titleFromMessage(text: string): string {
  const line = text.replace(/@[\w./-]+/g, (m) => m.split('/').pop() ?? m).split(/\r?\n/).find((l) => l.trim()) ?? 'Conversación'
  const clean = line.trim().replace(/\s+/g, ' ')
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean
}
