/** Edición por búsqueda/sustitución exacta (más fiable que los diffs para modelos pequeños). */

export interface Edit {
  old_string: string
  new_string: string
}

export class EditError extends Error {}

const norm = (s: string) => s.replace(/\r\n/g, '\n')

/**
 * Aplica ediciones en orden. Cada `old_string` debe aparecer exactamente una vez (salvo `replace_all`).
 * Conserva el fin de línea del archivo (CRLF/LF).
 */
export function applyEdits(content: string, edits: Edit[], replaceAll = false, notes?: string[]): string {
  const crlf = content.includes('\r\n')
  let text = norm(content)
  // Líneas que no cambian (antigua = nueva): se ignoran; solo es un error si NADA cambia (Fase 11)
  const real = edits.filter((e) => norm(e.old_string) !== norm(e.new_string))
  if (!real.length) throw new EditError('Ninguna edición cambia nada: old_string y new_string son iguales.')
  // old_string vacío = añadir al final, pero solo como edición única: en una lista de ediciones línea a línea
  // pegaría líneas sueltas al final del archivo
  if (real.length > 1 && real.some((e) => !norm(e.old_string)))
    throw new EditError('old_string vacío solo sirve para añadir al final del archivo, en una edición sola. Para cambiar varias líneas seguidas, usa un único old_string con el bloque completo (o write_file si el archivo es pequeño).')
  real.forEach((e, i) => {
    const oldS = norm(e.old_string)
    const newS = fixEscapedEdges(norm(e.new_string))
    // old_string vacío = añadir al final del archivo (Fase 11: los modelos lo intentaban anclando en «}» y fallaban)
    if (!oldS) {
      if (!newS) throw new EditError(`Edición ${i + 1}: old_string y new_string están vacíos.`)
      const sep = !text || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
      text = `${text}${sep}${newS}${newS.endsWith('\n') ? '' : '\n'}`
      return
    }
    const first = text.indexOf(oldS)
    if (first < 0) {
      // Tolerancia: mismas líneas con otra sangría, o copiadas con los números de línea de read_file
      const loose = looseReplace(text, oldS, newS) ?? looseReplace(text, stripLineNumbers(oldS), stripLineNumbers(newS))
      if (loose === 'ambiguous') throw new EditError(`Edición ${i + 1}: el fragmento aparece varias veces (ignorando la sangría). Incluye más líneas de contexto.`)
      if (loose !== null) {
        text = loose
        return
      }
      // Ya aplicada antes (el modelo repite una edición que hizo él mismo): no es un error (Fase 11)
      if (newS.trim() && text.includes(newS)) {
        notes?.push(`Edición ${i + 1}: ya estaba aplicada (el archivo ya contiene new_string).`)
        return
      }
      throw new EditError(`Edición ${i + 1}: no se encontró old_string en el archivo.${hint(text, oldS)}`)
    }
    const second = text.indexOf(oldS, first + 1)
    // Ancla mínima repetida («}», «});») y el texto nuevo es esa misma ancla más algo añadido: el modelo quiere
    // insertar DESPUÉS de la última (añadir al final). Medido en la Fase 11: Gemma 4 lo hace así para añadir pruebas
    // y no atiende a la indicación de usar old_string vacío. Es una inserción pura y queda en el diff.
    if (second >= 0 && !replaceAll && oldS.trim().length <= 3 && newS.startsWith(oldS) && newS.length > oldS.length) {
      const last = text.lastIndexOf(oldS)
      notes?.push(`Edición ${i + 1}: «${oldS.trim()}» aparece varias veces; se añadió el texto después de la última (línea ${text.slice(0, last).split('\n').length}).`)
      text = text.slice(0, last) + newS + text.slice(last + oldS.length)
      return
    }
    // Ancla mínima repetida y el texto nuevo empieza por un salto de línea sin repetir el ancla: el modelo usa
    // edit_file como «insertar después de» (Fase 11, Gemma 4). Se conserva el ancla y se inserta tras la última.
    if (second >= 0 && !replaceAll && oldS.trim().length <= 3 && newS.startsWith('\n') && newS.trim().length > 0) {
      const last = text.lastIndexOf(oldS)
      notes?.push(`Edición ${i + 1}: «${oldS.trim()}» aparece varias veces; se conservó y se añadió el texto después de la última (línea ${text.slice(0, last).split('\n').length}).`)
      text = text.slice(0, last + oldS.length) + newS + text.slice(last + oldS.length)
      return
    }
    if (second >= 0 && !replaceAll) {
      const line = text.slice(0, first).split('\n').length
      const line2 = text.slice(0, second).split('\n').length
      throw new EditError(
        `Edición ${i + 1}: old_string aparece varias veces (líneas ${line} y ${line2}…). Incluye más líneas de contexto para que sea único${oldS.trim().length <= 3 ? '. Si quieres añadir texto al final del archivo, usa old_string vacío ("")' : ''}.`,
      )
    }
    text = replaceAll ? text.split(oldS).join(newS) : text.slice(0, first) + newS + text.slice(first + oldS.length)
  })
  return crlf ? text.replace(/\n/g, '\r\n') : text
}

/** Sugiere líneas parecidas cuando no se encuentra el fragmento (p. ej. diferencias de espacios). */
function hint(text: string, oldS: string): string {
  const firstLine = oldS.split('\n').find((l) => l.trim())?.trim()
  if (!firstLine) return ''
  const lines = text.split('\n')
  const hits = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.trim() === firstLine || (firstLine.length > 12 && l.includes(firstLine.slice(0, Math.min(40, firstLine.length)))))
    .slice(0, 3)
  if (!hits.length) return ' Lee el archivo con read_file y copia el fragmento exacto.'
  return ` Líneas parecidas: ${hits.map(({ l, i }) => `${i + 1}: ${l.trim().slice(0, 80)}`).join(' | ')}. Copia el texto exacto (incluidos espacios e indentación).`
}

/** Quita prefijos «   12│ » que read_file añade y que algunos modelos copian. */
export function stripLineNumbers(s: string): string {
  const lines = s.split('\n')
  const numbered = lines.filter((l) => l.trim()).every((l) => /^\s*\d+│ ?/.test(l))
  return numbered ? lines.map((l) => l.replace(/^\s*\d+│ ?/, '')).join('\n') : s
}

const indentOf = (l: string) => /^[ \t]*/.exec(l)![0]

/**
 * Busca un bloque de líneas igual a `oldS` ignorando la sangría y lo sustituye por `newS`
 * re-sangrado con la del archivo. Devuelve el texto nuevo, 'ambiguous' si hay varias coincidencias o null.
 */
export function looseReplace(text: string, oldS: string, newS: string): string | 'ambiguous' | null {
  const oldLines = oldS.replace(/\n$/, '').split('\n')
  while (oldLines.length && !oldLines[0]!.trim()) oldLines.shift()
  if (!oldLines.length) return null
  const fileLines = text.split('\n')
  const matches: number[] = []
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    if (oldLines.every((ol, j) => fileLines[i + j]!.trim() === ol.trim())) matches.push(i)
  }
  if (matches.length === 0) return null
  if (matches.length > 1) return 'ambiguous'
  const start = matches[0]!
  const fileIndent = indentOf(fileLines[start]!)
  // Traducción de sangrías: la que usó el modelo → la real del archivo, línea a línea
  const map = new Map<string, string>()
  oldLines.forEach((ol, j) => {
    if (ol.trim() && !map.has(indentOf(ol))) map.set(indentOf(ol), indentOf(fileLines[start + j]!))
  })
  const reindent = (l: string) => {
    if (!l.trim()) return l
    const ind = indentOf(l)
    let best: string | undefined
    for (const k of map.keys()) if (ind.startsWith(k) && (best === undefined || k.length > best.length)) best = k
    return best === undefined ? fileIndent + l.trimStart() : map.get(best)! + l.slice(best.length)
  }
  const newLines = newS.replace(/\n$/, '').split('\n')
  while (newLines.length > 1 && !newLines[0]!.trim()) newLines.shift()
  const reindented = newS.trim() === '' ? [] : newLines.map(reindent)
  return [...fileLines.slice(0, start), ...reindented, ...fileLines.slice(start + oldLines.length)].join('\n')
}

/**
 * Algunos modelos escriben los saltos de línea del principio o del final como texto («\\n\\ntest(…»). Ningún
 * código empieza ni termina con una barra invertida seguida de n, así que esos extremos se convierten en saltos
 * reales; el interior no se toca (podría ser un \\n legítimo dentro de una cadena).
 */
export function fixEscapedEdges(s: string): string {
  return s.replace(/^(?:\\n)+/, (m) => '\n'.repeat(m.length / 2)).replace(/(?:\\n)+$/, (m) => '\n'.repeat(m.length / 2))
}
