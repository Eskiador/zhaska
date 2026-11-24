import { StatusBar } from '@renderer/layout/StatusBar'
import { Shell, Workbench } from '@renderer/layout/Workbench'
import { useShortcuts } from '@renderer/layout/useShortcuts'
import { MenuHost, Toaster } from '@renderer/components/ui/overlays'
import { ConfirmHost } from '@renderer/components/ui/confirm'
import { CommandPalette } from '@renderer/features/palette/CommandPalette'
import { SettingsDialog } from '@renderer/features/settings/SettingsDialog'
import { ModelsDialog } from '@renderer/features/models/ModelsDialog'
import { AttachmentsDialog } from '@renderer/features/attachments/AttachmentsDialog'
import { AttachmentPreview } from '@renderer/features/chat/preview'
import { NewProjectDialog } from '@renderer/features/projects/NewProjectDialog'
import { Onboarding } from '@renderer/features/onboarding/Onboarding'
import { Welcome } from '@renderer/features/welcome/Welcome'
import { AssistantView } from '@renderer/features/assistant/AssistantView'
import { useWorkspace } from '@renderer/stores/workspace'
import { useUI } from '@renderer/stores/ui'
import { useSettings } from '@renderer/stores/settings'

export default function App() {
  const hasProject = useWorkspace((s) => !!s.project)
  const view = useUI((s) => s.view)
  const onboarding = useUI((s) => s.onboarding)
  const reduceMotion = useSettings((s) => s.reduceMotion)
  useShortcuts()

  return (
    <div className="flex h-full flex-col" data-reduce-motion={reduceMotion || undefined} onContextMenu={(e) => e.preventDefault()}>
      <Shell>{view === 'assistant' ? <AssistantView /> : hasProject ? <Workbench /> : <Welcome />}</Shell>
      <StatusBar />

      <CommandPalette />
      <SettingsDialog />
      <ModelsDialog />
      <AttachmentsDialog />
      <AttachmentPreview />
      <NewProjectDialog />
      <ConfirmHost />
      {onboarding && <Onboarding />}
      <MenuHost />
      <Toaster />
    </div>
  )
}
