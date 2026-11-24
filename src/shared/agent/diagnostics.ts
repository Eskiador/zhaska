/** Errores estructurados a partir de la salida de tsc / Python (lo usan el agente y el panel «Problemas»). */
export function parseDiagnostics(output: string): { file: string; line: number; message: string }[] {
  const out: { file: string; line: number; message: string }[] = []
  const tsRe = /^(.+?)\((\d+),\d+\): error (TS\d+: .+)$/
  const tsRe2 = /^(.+?):(\d+):\d+ - error (TS\d+: .+)$/
  const pyRe = /File "(.+?)", line (\d+)/
  const lines = output.split(/\r?\n/)
  lines.forEach((l, i) => {
    const m = tsRe.exec(l) ?? tsRe2.exec(l)
    if (m) out.push({ file: m[1]!.trim(), line: Number(m[2]), message: m[3]!.trim() })
    const p = pyRe.exec(l)
    if (p) out.push({ file: p[1]!, line: Number(p[2]), message: (lines[i + 2] ?? lines[i + 1] ?? '').trim() })
  })
  return out.slice(0, 50)
}
