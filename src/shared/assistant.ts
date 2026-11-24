/**
 * Asistente de empresa (Fase 12): reglas del chat con documentos, compartidas por main (prompt) y la interfaz
 * (plantillas). El asistente no tiene herramientas: solo lee los fragmentos que le da la búsqueda local.
 */

/** Fragmento recuperado de una base de conocimiento, tal como se cita en una respuesta. */
export interface AssistantSource {
  /** Número de la cita: [1], [2]… */
  n: number
  documentId: string
  collectionId: string
  /** Nombre del archivo y ruta dentro de la carpeta */
  name: string
  relPath: string
  page: number | null
  section: string | null
  /** Texto del fragmento (no se guarda en las conversaciones de bases confidenciales) */
  text: string
}

/** Los modelos solo de embeddings (embeddinggemma…) no sirven para conversar: fuera de los selectores de chat. */
export const isChatModel = (m: { capabilities: string[] }) => !(m.capabilities.includes('embedding') && !m.capabilities.includes('completion'))

export const NOT_FOUND_PHRASE = 'No aparece en tus documentos'

export function assistantSystemPrompt(ctx: { collections: string[]; date: string }): string {
  const docs = ctx.collections.length
    ? `Tienes acceso a fragmentos de estas bases de conocimiento del usuario: ${ctx.collections.join(', ')}.`
    : 'En esta conversación no hay bases de conocimiento conectadas: solo puedes usar lo que el usuario escriba o adjunte.'
  return [
    'Eres el asistente de oficina de ZHASKA. Funcionas en local, en el ordenador del usuario: nada de lo que lees sale de él.',
    'Ayudas con trabajo administrativo: responder preguntas sobre documentos, resumir, redactar correos, traducir y ordenar datos.',
    docs,
    '',
    'Reglas:',
    '1. Responde siempre en español (salvo que te pidan traducir a otro idioma), con frases claras y sin rodeos.',
    '2. Cuando uses información de los fragmentos, cita su número entre corchetes justo después del dato, por ejemplo: «El plazo es de 60 días [2]». Cita solo números que aparezcan en los fragmentos.',
    `3. Si la respuesta no está en los fragmentos ni en lo que ha escrito o adjuntado el usuario, dilo con estas palabras: «${NOT_FOUND_PHRASE}». Después, si puedes, indica qué documento haría falta. Nunca inventes datos, importes, fechas, nombres ni números de documento.`,
    '4. Si los fragmentos se contradicen, dilo y cita los dos.',
    '5. Al dar importes, fechas, códigos de cliente o números de documento, cópialos exactamente como aparecen y recuerda que conviene comprobarlos en el documento original.',
    '6. No tienes herramientas: no puedes abrir archivos, enviar correos ni modificar nada. Si te piden hacerlo, prepara el texto para que el usuario lo haga.',
    `Fecha de hoy: ${ctx.date}.`,
  ].join('\n')
}

/** Bloque que se añade a la pregunta del usuario con los fragmentos encontrados. */
export function sourcesBlock(sources: AssistantSource[]): string {
  if (!sources.length) return `[Búsqueda en tus documentos: no se encontró ningún fragmento relacionado. Si la pregunta trata de tus documentos, responde «${NOT_FOUND_PHRASE}».]`
  const parts = sources.map((s) => {
    const where = [s.relPath, s.page ? `página ${s.page}` : null, s.section].filter(Boolean).join(' · ')
    return `[${s.n}] ${where}\n${s.text}`
  })
  return `Fragmentos de tus documentos (cítalos por su número):\n\n${parts.join('\n\n')}`
}

/** Números de cita que aparecen en una respuesta ([1], [2, 3]…), sin repetir. */
export function citedNumbers(text: string): number[] {
  const out = new Set<number>()
  for (const m of text.matchAll(/\[(\d+(?:\s*[,;]\s*\d+)*)\]/g)) for (const n of m[1]!.split(/[,;]/)) out.add(Number(n.trim()))
  return [...out].sort((a, b) => a - b)
}

export interface AssistantTemplate {
  id: string
  label: string
  /** Texto que se pone en el cuadro de mensaje; «…» marca dónde completar */
  text: string
  hint: string
}

export const ASSISTANT_TEMPLATES: AssistantTemplate[] = [
  { id: 'ask', label: 'Preguntar a mis documentos', text: '¿Qué dicen mis documentos sobre …?', hint: 'Busca en las bases de conocimiento conectadas y cita las fuentes.' },
  { id: 'summary', label: 'Resumir un documento', text: 'Resume el documento adjunto en 5 puntos clave, con importes y fechas si los hay.', hint: 'Adjunta el PDF, Word o Excel.' },
  { id: 'email', label: 'Redactar un correo', text: 'Redacta un correo formal en español para … explicando que …', hint: 'Indica destinatario y motivo; revisa el texto antes de enviarlo tú.' },
  { id: 'translate', label: 'Traducir', text: 'Traduce al español el documento adjunto y señala los importes, fechas y referencias.', hint: 'Francés, alemán, portugués, italiano, polaco, inglés…' },
  { id: 'compare', label: 'Comparar dos Excel', text: 'Compara los dos Excel adjuntos y dime qué filas están en uno y no en el otro y qué importes cambian.', hint: 'Adjunta los dos archivos.' },
  { id: 'table', label: 'Sacar datos a una tabla', text: 'Del documento adjunto, saca en una tabla: número de documento, fecha, cliente, concepto e importe.', hint: 'Devuelve una tabla en Markdown que puedes copiar a Excel.' },
]
