import { File, FileArchive, FileBraces, FileCode, FileImage, FileSpreadsheet, FileText, Folder, FolderOpen } from 'lucide-react'
import { extOf } from '@renderer/lib/format'

const CODE_COLORS: Record<string, string> = {
  ts: '#7FB2FF',
  tsx: '#7FB2FF',
  js: '#E7C07B',
  jsx: '#E7C07B',
  py: '#7FB2FF',
  css: '#C49BFF',
  scss: '#C49BFF',
  html: '#F0A070',
}

export function FileIcon({ name, open, dir, className = 'size-3.5' }: { name: string; open?: boolean; dir?: boolean; className?: string }) {
  if (dir) return open ? <FolderOpen className={className} style={{ color: 'var(--color-accent)' }} /> : <Folder className={className} style={{ color: 'var(--color-fg-3)' }} />
  const ext = extOf(name)
  if (ext === 'json') return <FileBraces className={className} style={{ color: '#E7C07B' }} />
  if (['md', 'txt', 'pdf', 'docx'].includes(ext)) return <FileText className={className} style={{ color: ext === 'pdf' ? '#F48C95' : 'var(--color-fg-2)' }} />
  if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'].includes(ext)) return <FileImage className={className} style={{ color: '#9381FF' }} />
  if (['xlsx', 'xls', 'csv'].includes(ext)) return <FileSpreadsheet className={className} style={{ color: '#6BD3A3' }} />
  if (ext === 'zip') return <FileArchive className={className} style={{ color: 'var(--color-fg-2)' }} />
  if (CODE_COLORS[ext]) return <FileCode className={className} style={{ color: CODE_COLORS[ext] }} />
  return <File className={className} style={{ color: 'var(--color-fg-3)' }} />
}
