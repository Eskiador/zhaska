/** Funciones que aún no existen se muestran bloqueadas con la fase en la que llegan (ROADMAP.md). */
export const PHASE_NAMES: Record<number, string> = {
  3: 'Electron y sistema local',
  4: 'Ollama y Gemma',
  5: 'Agente de programación',
  6: 'Actividad en tiempo real',
  7: 'Terminal y editor',
  8: 'Adjuntos',
  9: 'Seguridad y persistencia',
  10: 'Instalación y actualizaciones',
  11: 'Pruebas y optimización',
}

/** Última fase terminada (se muestra en Configuración → Acerca de). */
export const CURRENT_PHASE = 11

export const lockedHint = (phase: number) => `Disponible en la Fase ${phase} · ${PHASE_NAMES[phase] ?? ''}`
