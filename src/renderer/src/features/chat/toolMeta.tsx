import { Eye, FileCode, FilePlus, FileSearch, FolderTree, ListChecks, Package, Paperclip, Pencil, Settings2, SquareTerminal, Stethoscope, Trash, FlaskConical } from 'lucide-react'
import type { ToolName } from '@shared/agent/events'

export const TOOL_ICON: Record<ToolName, typeof Eye> = {
  get_project_structure: FolderTree,
  list_files: FolderTree,
  read_file: FileCode,
  search_code: FileSearch,
  read_project_config: Settings2,
  read_attachment: Paperclip,
  update_plan: ListChecks,
  create_file: FilePlus,
  edit_file: Pencil,
  write_file: Pencil,
  delete_file: Trash,
  execute_command: SquareTerminal,
  install_dependencies: Package,
  run_tests: FlaskConical,
  inspect_errors: Stethoscope,
}
