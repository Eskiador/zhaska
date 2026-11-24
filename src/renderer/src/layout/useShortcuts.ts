import { useEffect } from 'react'
import { isMod } from '@renderer/lib/platform'
import { hasBackend } from '@renderer/lib/api'
import { useChat } from '@renderer/stores/chat'
import { useLayout } from '@renderer/stores/layout'
import { pickAndOpenFolder } from '@renderer/stores/projects'
import { useUI } from '@renderer/stores/ui'
import { useWorkspace } from '@renderer/stores/workspace'

/** Atajos globales. Mod = Ctrl en Windows, ⌘ en macOS. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e) || e.altKey) return
      const k = e.key.toLowerCase()
      const ui = useUI.getState()
      const layout = useLayout.getState()
      const ws = useWorkspace.getState()
      const project = ws.project
      const run = (fn: () => void) => {
        e.preventDefault()
        fn()
      }
      if (k === 'k' || (k === 'p' && !e.shiftKey)) return run(() => (ui.dialog === 'palette' ? ui.closeDialog() : ui.openDialog('palette')))
      if (k === ',') return run(() => ui.openDialog('settings'))
      if (k === 'n' && e.shiftKey) return run(() => ui.openDialog('newProject'))
      if (k === 'o' && !e.shiftKey && hasBackend) return run(() => void pickAndOpenFolder())
      if (k === 'b') return run(() => layout.toggle('sidebar'))
      if (!project) return
      if (k === 'n') return run(() => void useChat.getState().newConversation(project.id))
      if (k === 's' && ws.activeTab) return run(() => void ws.save(ws.activeTab!))
      if (k === '1' || k === '2' || k === '3') return run(() => layout.applyPreset(k === '1' ? 'agent' : k === '2' ? 'ide' : 'full'))
      if (k === 'j') return run(() => layout.toggle('terminal'))
      if (k === 'e' && e.shiftKey) return run(() => layout.toggle('explorer'))
      if (k === 'i' && e.shiftKey) return run(() => layout.toggle('activity'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
