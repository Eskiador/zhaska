import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/index.css'
import App from './App'
import { bootstrap } from './stores/projects'

// Ajustes, proyectos recientes y último proyecto (SQLite vía IPC). Sin backend: demostración.
void bootstrap().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  // Interfaz pintada y usable (Fase 11: medición del arranque en Configuración → Acerca de y en las pruebas)
  requestAnimationFrame(() => requestAnimationFrame(() => (document.documentElement.dataset['ready'] = String(Date.now()))))
})
