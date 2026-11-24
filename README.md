# ZHASKA

Entorno de programación de escritorio para Windows con un **agente de IA que se ejecuta en tu ordenador**. Describe lo que quieres construir; el agente explora tu proyecto, planifica, crea y modifica archivos, ejecuta comandos, detecta errores y los corrige, mientras ves cada acción real en el panel de actividad.

- **Local-first**: modelos vía [Ollama](https://ollama.com) (Gemma 4 por defecto). Tus proyectos, conversaciones y documentos no salen de tu equipo.
- **Agente propio**, independiente del modelo: puedes cambiar de modelo sin cambiar la aplicación.
- **IDE completo**: Monaco, terminal real, explorador, diff con aceptar/rechazar, checkpoints.
- **Asistente de oficina**: un chat aparte para preguntar a tus documentos (carpetas que eliges, indexadas en local), resumir, redactar y traducir. Cita de qué documento y página sale cada dato y, si no lo encuentra, lo dice. Conversaciones privadas que no se guardan y bases confidenciales.
- **Adjuntos**: PDF (también escaneados, con OCR), Word, Excel, CSV, código, imágenes y ZIP. Se procesan en local y la IA puede leerlos pero no modificarlos.
- **Seguro por defecto**: el agente trabaja dentro del proyecto; lo peligroso, los borrados, los archivos protegidos y cualquier lectura fuera del proyecto piden tu confirmación. Copias de seguridad diarias que puedes restaurar, y exportar o importar todos tus datos en un archivo.

> **Estado: las 11 fases del plan están completadas y aprobadas; la Fase 12 (asistente de oficina) está terminada y pendiente de tu aprobación.** Instalado y funcionando en el PC con Windows (24-11-2026); quedan por hacer allí la prueba de actualización y las mediciones completas del agente con la RTX 5060, siguiendo [docs/WINDOWS.md](docs/WINDOWS.md). Ver [ROADMAP.md](ROADMAP.md).

## Instalación (Windows)

1. Descarga `ZHASKA-Setup-X.Y.Z.exe` y ábrelo.
2. El instalador no está firmado: Windows SmartScreen mostrará «Windows protegió su PC». Pulsa **Más información → Ejecutar de todas formas**.
3. Se instala solo para tu usuario, sin permisos de administrador, en `%LOCALAPPDATA%\Programs\ZHASKA` (puedes elegir otra carpeta). Tus datos quedan aparte, en `%APPDATA%\ZHASKA`: actualizar o desinstalar no los borra.
4. Al abrirla por primera vez, el asistente comprueba el equipo, instala Ollama si hace falta, descarga el modelo recomendado, lo prueba (también con una herramienta real) y te deja una primera tarea para el agente.

Actualizaciones: si las activas, ZHASKA consulta GitHub Releases al iniciar y cada 6 horas (solo envía la versión instalada). Descargar e instalar siempre lo decides tú, y antes se guarda una copia de tus datos. Cómo probar todo esto en el PC: [docs/WINDOWS.md](docs/WINDOWS.md).

## Documentación

| Documento | Contenido |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Procesos, IPC, agente, herramientas, Ollama, almacenamiento, seguridad, estructura de carpetas, riesgos |
| [docs/WINDOWS.md](docs/WINDOWS.md) | Probar en Windows: instalador, asistente inicial, primera tarea y actualización |
| [docs/PROPUESTA-IT.md](docs/PROPUESTA-IT.md) | Propuesta para IT: qué hace el asistente de oficina, qué datos toca, red, riesgos y resultados medidos |
| [docs/SECURITY.md](docs/SECURITY.md) | Modelo de amenazas, lista de comprobación de Electron, auditoría del IPC, permisos del agente, copias y restauración |
| [docs/MODELS.md](docs/MODELS.md) | Análisis de Gemma 4 en Ollama para una RTX 5060 de 8 GB y recomendación |
| [docs/DESIGN.md](docs/DESIGN.md) | Sistema de diseño: tokens, tipografía, disposición, componentes |
| [docs/design/mockup.html](docs/design/mockup.html) | Maqueta visual estática (ábrela en un navegador; datos simulados) |
| [ROADMAP.md](ROADMAP.md) | Fases, criterios de salida y decisiones pendientes |
| [CHANGELOG.md](CHANGELOG.md) | Historial de cambios |

## Requisitos previstos (usuario final)

- Windows 10 22H2 o Windows 11, x64.
- 16 GB de RAM mínimo (32 GB recomendados para modelos grandes).
- GPU NVIDIA con ≥ 6 GB de VRAM recomendada (funciona en CPU, más lento).
- Ollama: la aplicación lo detecta y ofrece instalarlo.
- Conexión a Internet solo para la instalación inicial y la descarga de modelos.

Node.js, Python y Git **no** son necesarios para usar la app; solo si tus proyectos los requieren (la app lo detecta y avisa).

## Desarrollo

Requisitos: Node.js 24+ (probado con Node 24 y 26) y npm 11. Los scripts de instalación de Electron y node-pty están autorizados en `allowScripts` de `package.json`; `scripts/postinstall.cjs` da permiso de ejecución al ayudante de node-pty en macOS/Linux.

```bash
npm install          # instala dependencias y descarga Electron
npm run dev          # app de escritorio con recarga en caliente
npm run dev:web      # solo la interfaz en el navegador (http://localhost:5199), sin Electron
npm run typecheck    # TypeScript (main/preload y renderer)
npm test             # tests unitarios (PathGuard, SQLite, archivos, contrato IPC, agente, terminal real)
npm run smoke        # compila y prueba la app real de extremo a extremo (con Ollama, también chat y agente)
npm run test:restore # restaura una copia, exporta e importa con tres arranques reales de la app
npm run test:package # empaqueta la app (ASAR, fusibles) y prueba el ejecutable real: adjuntos con OCR, terminal, agente
npm run test:update  # compila 0.1.0 y 0.1.1 y prueba buscar, descargar e instalar la actualización conservando los datos
npm run test:perf    # rendimiento de la app empaquetada: arranque, memoria y un proyecto de 50 000 archivos
ZHASKA_EVAL_MODEL=gemma4:12b-it-qat npm run eval:agent -- tests/eval/long.eval.ts   # tres tareas largas encadenadas del agente
npm run dist         # instalador de la plataforma actual en dist/ (Windows: npm run dist:win; desde un Mac M, con Rosetta 2)
ZHASKA_EVAL_MODEL=gemma4:12b-it-qat npm run eval:agent   # 7 tareas reales del agente con un modelo de Ollama (incluida una con adjunto)
ZHASKA_EVAL_TEMPLATES=1 npm run eval:agent -- tests/eval/templates.eval.ts   # plantillas, clonado y «npm run dev» en la terminal (Internet)
npm run build        # compila a out/
```

| Carpeta | Contenido |
|---|---|
| `src/main/` | Proceso principal: ventana segura, IPC, SQLite, PathGuard, archivos, proyectos |
| `src/preload/` | Puente `window.zhaska` (solo los canales del contrato) |
| `src/shared/` | Contrato IPC, eventos del agente, catálogo de modelos |
| `src/renderer/src/` | Interfaz React: `components/`, `layout/`, `features/`, `stores/` |
| `src/renderer/src/demo/` | ⚠️ Datos simulados de la Fase 2 |

Atajos (Ctrl en Windows, ⌘ en macOS): `Ctrl K` buscar · `Ctrl N` nueva conversación · `Ctrl ⇧ N` nuevo proyecto · `Ctrl O` abrir carpeta · `Ctrl S` guardar · `Ctrl 1/2/3` modos · `Ctrl B` barra lateral · `Ctrl ⇧ E` explorador · `Ctrl J` terminal · `Ctrl ⇧ I` actividad · `Ctrl ,` configuración.

Datos en desarrollo: `~/Library/Application Support/ZHASKA-dev` (macOS) o `%APPDATA%\ZHASKA-dev` (Windows), separados de los de la app instalada.

Repositorio: [github.com/Eskiador/zhaska](https://github.com/Eskiador/zhaska). Publicar una versión: sube una etiqueta `vX.Y.Z`; `.github/workflows/release.yml` pasa las pruebas en Windows, genera el instalador y deja un **borrador** en GitHub Releases que publicas tú tras probarlo.
