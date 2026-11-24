import type { ReactNode } from 'react'
import { Group, Panel, Separator, useDefaultLayout, type PanelImperativeHandle } from 'react-resizable-panels'
import { Sidebar } from '@renderer/features/sidebar/Sidebar'
import { ChatPanel } from '@renderer/features/chat/ChatPanel'
import { ActivityPanel } from '@renderer/features/activity/ActivityPanel'
import { ExplorerPanel } from '@renderer/features/explorer/ExplorerPanel'
import { EditorPanel } from '@renderer/features/editor/EditorPanel'
import { TerminalPanel } from '@renderer/features/terminal/TerminalPanel'
import { panelHandles, useLayout, type PanelId } from '@renderer/stores/layout'
import { TitleBar } from './TitleBar'

function safeStorage() {
  try {
    return localStorage
  } catch {
    return undefined
  }
}

const register = (id: PanelId) => (h: PanelImperativeHandle | null) => {
  panelHandles[id] = h
}

const onResize = (id: PanelId) => (size: { inPixels: number }) => {
  const collapsed = size.inPixels < 1
  if (useLayout.getState().collapsed[id] !== collapsed) useLayout.getState().setCollapsed(id, collapsed)
}

/**
 * Distribución de la referencia (DESIGN.md §0): Sidebar a toda altura | barra de título +
 * Chat | Actividad | (Explorador | Editor) / Terminal. Todo redimensionable y plegable; los tamaños se recuerdan.
 */
export function Shell({ children }: { children: ReactNode }) {
  const storage = safeStorage()
  const outer = useDefaultLayout({ id: 'zhaska.layout.v2.outer', storage })
  return (
    <Group orientation="horizontal" className="min-h-0 flex-1" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
      <Panel id="sidebar" panelRef={register('sidebar')} onResize={onResize('sidebar')} defaultSize={248} minSize={200} maxSize={340} collapsible collapsedSize={0} groupResizeBehavior="preserve-pixel-size">
        <Sidebar />
      </Panel>
      <Separator className="w-px" />
      <Panel id="main" minSize={600}>
        <div className="flex h-full min-w-0 flex-col">
          <TitleBar />
          {children}
        </div>
      </Panel>
    </Group>
  )
}

export function Workbench() {
  const storage = safeStorage()
  const main = useDefaultLayout({ id: 'zhaska.layout.v2.main', storage })
  const right = useDefaultLayout({ id: 'zhaska.layout.v2.right', storage })
  const files = useDefaultLayout({ id: 'zhaska.layout.v2.files', storage })

  return (
    <Group orientation="horizontal" className="min-h-0 flex-1" defaultLayout={main.defaultLayout} onLayoutChanged={main.onLayoutChanged}>
      <Panel id="chat" panelRef={register('chat')} onResize={onResize('chat')} minSize={420} defaultSize="34%">
        <ChatPanel />
      </Panel>
      <Separator className="w-px" />
      <Panel id="activity" panelRef={register('activity')} onResize={onResize('activity')} defaultSize={296} minSize={248} maxSize={420} collapsible collapsedSize={0} groupResizeBehavior="preserve-pixel-size">
        <ActivityPanel />
      </Panel>
      <Separator className="w-px" />
      <Panel id="workbench" panelRef={register('workbench')} onResize={onResize('workbench')} minSize={420} collapsible collapsedSize={0}>
        <Group orientation="vertical" defaultLayout={right.defaultLayout} onLayoutChanged={right.onLayoutChanged}>
          <Panel id="files" minSize={140}>
            <Group orientation="horizontal" defaultLayout={files.defaultLayout} onLayoutChanged={files.onLayoutChanged}>
              <Panel id="explorer" panelRef={register('explorer')} onResize={onResize('explorer')} defaultSize={188} minSize={150} maxSize={300} collapsible collapsedSize={0} groupResizeBehavior="preserve-pixel-size">
                <ExplorerPanel />
              </Panel>
              <Separator className="w-px" />
              <Panel id="editor" minSize={260}>
                <EditorPanel />
              </Panel>
            </Group>
          </Panel>
          <Separator className="sep-v h-px" />
          <Panel id="terminal" panelRef={register('terminal')} onResize={onResize('terminal')} defaultSize={220} minSize={90} collapsible collapsedSize={0} groupResizeBehavior="preserve-pixel-size">
            <TerminalPanel />
          </Panel>
        </Group>
      </Panel>
    </Group>
  )
}
