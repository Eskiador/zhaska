import { extOf } from '@renderer/lib/format'

const MAP: Record<string, { id: string; label: string }> = {
  ts: { id: 'typescript', label: 'TypeScript' },
  tsx: { id: 'typescript', label: 'TypeScript React' },
  js: { id: 'javascript', label: 'JavaScript' },
  jsx: { id: 'javascript', label: 'JavaScript React' },
  json: { id: 'json', label: 'JSON' },
  md: { id: 'markdown', label: 'Markdown' },
  css: { id: 'css', label: 'CSS' },
  scss: { id: 'scss', label: 'SCSS' },
  html: { id: 'html', label: 'HTML' },
  svg: { id: 'xml', label: 'SVG' },
  xml: { id: 'xml', label: 'XML' },
  py: { id: 'python', label: 'Python' },
  sql: { id: 'sql', label: 'SQL' },
  yml: { id: 'yaml', label: 'YAML' },
  yaml: { id: 'yaml', label: 'YAML' },
  sh: { id: 'shell', label: 'Shell' },
  ps1: { id: 'powershell', label: 'PowerShell' },
}

export function languageOf(path: string) {
  return MAP[extOf(path)] ?? { id: 'plaintext', label: 'Texto' }
}
