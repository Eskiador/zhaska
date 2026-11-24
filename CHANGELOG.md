# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido — Fase 12: asistente de oficina (24-11-2026)
- **Selector Chat / Código** arriba de la barra lateral, como en la app de Claude (atajo Ctrl+Mayús+M; recuerda el último modo). En Chat, la barra lateral muestra las conversaciones del asistente y las bases de conocimiento; en Código, los proyectos.
- **Asistente de oficina** (modo Chat): un chat aparte del de programación para preguntar a tus documentos, resumir, redactar correos, traducir y pasar datos a tablas, con plantillas para cada tarea.
- **Bases de conocimiento**: eliges carpetas (solo lectura) y ZHASKA indexa en tu equipo sus PDF (también escaneados), Word, Excel, CSV, texto e imágenes. Se ponen al día solas cuando cambian; los documentos con problemas aparecen con el motivo.
- **Respuestas con fuentes**: cada dato lleva su cita ([1], [2]…) con documento y página, desplegable y con «Abrir». Si no está en tus documentos, dice «No aparece en tus documentos»; si cita una fuente que no existe o da cifras sin citar, la app avisa.
- **Conversaciones privadas** (solo en memoria) y **bases confidenciales** (solo en conversaciones privadas).
- Búsqueda local combinada por palabras (FTS5) y por significado (EmbeddingGemma en Ollama, ≈ 620 MB, se descarga desde la base de conocimiento).
- El modo Chat usa Gemma 4 E4B por defecto si está instalado (medido: 12/12 aciertos y citas, igual que el 12B, en 20 s frente a 49 s).
- `docs/PROPUESTA-IT.md`: propuesta para presentar a IT. Evaluación `tests/eval/assistant.eval.ts` y 11 pruebas nuevas; la prueba completa de la app pasa a 64 comprobaciones.

### Corregido
- Los modelos que solo sirven para búsqueda (embeddings) ya no aparecen en el selector de modelos del chat.

### Mejorado — Modelos en tarjetas de 8 GB (24-11-2026, medido en el PC con Windows)
- La barra lateral avisa cuando el modelo cargado no cabe entero en la tarjeta gráfica y parte va al procesador (más lento), y explica por qué y qué alternativa hay.
- Estimación de memoria corregida con las medidas reales (el 12B necesita ≈ 10 GB, no 8) y textos de los modelos con datos medidos: el 12B va a ~14 tok/s en una RTX 5060 pero es el que resuelve las tareas largas (3/3 frente a 0/3 del E4B, que va a 148 tok/s). Con menos de un 60 % en GPU ya no se recomienda el 12B.

### Corregido — Windows (24-11-2026, detectado por la integración continua de GitHub)
- **Los PDF no se podían leer en Windows**: la carpeta de fuentes de pdfjs se pasaba terminada en «\\» y pdfjs exige «/» («Invalid factory url»). Afectaba a PDF con texto y escaneados.
- **No se podían abrir proyectos dentro de la carpeta temporal de Windows** (`AppData\Local\Temp`) cuando Windows la da con nombre corto 8.3: se comparaba solo una forma de la ruta y se aplicaba la regla de `~\AppData`. Ahora se comparan las dos.
- Pruebas que solo fallaban en las máquinas Windows de GitHub: rutas cortas 8.3 del directorio temporal (`RUNNER~1`), primer arranque lento de PowerShell, limpieza de carpetas con archivos aún abiertos y la búsqueda en 50 000 archivos (allí se registra el tiempo en vez de exigir el de un PC normal).

### Añadido — Fase 11 (23-11-2026)
- **Buscar archivo en todo el proyecto** (Ctrl K): índice de nombres en el proceso principal que se mantiene al día con los cambios; antes solo encontraba archivos de carpetas ya abiertas en el explorador.
- **Rendimiento en Acerca de**: tiempo de arranque y memoria de cada proceso, medidos en tu equipo.
- **Ajuste de prompts por modelo, medido**: perfiles por tamaño y familia, y comparación de un prompt compacto frente al completo con Gemma 4 E4B (6/7 completo, 4/7 compacto → todos usan el completo; los pequeños, con la temperatura limitada). A ningún modelo se le ofrecen herramientas que tienes bloqueadas o que no aplican.
- Pruebas: rendimiento de la app empaquetada con un proyecto de 50 000 archivos (`npm run test:perf`), larga duración del agente (tres tareas encadenadas con pruebas ocultas, `tests/eval/long.eval.ts`) y comparación de estilos de prompt (`ZHASKA_EVAL_PROMPT`).

### Mejorado — Fase 11
- El proceso del agente arranca con el primer chat o tarea (unos 90 MB menos mientras solo exploras o editas) y el de adjuntos se cierra tras 2 minutos sin trabajo.
- Carpetas con miles de archivos: el explorador las muestra por tandas de 500.
- Nueva herramienta del agente `write_file` (reescribe entero un archivo pequeño, con su diff); `edit_file` puede añadir al final de un archivo (`old_string` vacío), ignora las líneas que no cambian y los errores de argumentos dicen exactamente qué falta.

### Corregido — Fase 11
- Si el modelo devolvía una respuesta vacía a mitad de tarea, el agente la daba por terminada («He terminado.») sin haber hecho nada. Ahora le pide que continúe; y si solo anuncia lo que «va a hacer» sin haber cambiado nada, se le recuerda una vez que lo haga.
- Si al agente se le olvida `path` en `edit_file`, se usa el último archivo que leyó (solo si el fragmento está en él, y se le avisa); repetir una edición ya aplicada ya no es un error.
- `edit_file` entiende las dos formas en que Gemma 4 intenta añadir texto al final (anclando en «}» con o sin repetir la llave) y convierte en saltos de línea reales los `\n` escritos como texto al principio o al final.
- La búsqueda en el código del agente (`search_code`) dejaba de buscar a los 5 000 archivos: en un proyecto de 50 000 no encontraba lo que estuviera después. Ahora lee en paralelo y recorre los 50 000 en unos 2 s.
- El agente se detenía al releer un archivo o volver a pasar las pruebas por tercera vez, aunque hubiera editado entre medias: el ciclo «editar → probar → corregir» no podía pasar de dos vueltas. Ahora cada cambio reinicia el control de repeticiones y, ante una repetición real, primero se le avisa con una pista concreta.

### Añadido — Fase 10 (23-11-2026)
- **Instalador de Windows** (electron-builder 26.18, `electron-builder.yml`): NSIS por usuario y sin administrador, en español, con elección de carpeta, accesos directos, desinstalador que no borra tus datos, icono y barras laterales propias (`build/`, generados desde el logotipo con `npm run icons`).
- **Fusibles de Electron** e **integridad del ASAR** en la app empaquetada: completa la lista de comprobación de seguridad (20/20).
- **Actualizaciones** con electron-updater 6.8: comprobar (si lo activas y tras el asistente), descargar con verificación sha512 e instalar con «Reiniciar e instalar», con copia «Antes de actualizar» de tus datos. Aviso en la barra de estado y novedades en Acerca de; al arrancar la nueva versión, «ZHASKA se actualizó». Sin repositorio, la app dice que las actualizaciones no están configuradas.
- **Asistente inicial completo**: requisitos (Windows 10 22H2+/11 x64, RAM), herramientas de desarrollo (solo informa), prueba real de herramientas del modelo sobre un proyecto de ejemplo temporal, la opción de buscar actualizaciones y «Probar el agente con un proyecto de ejemplo» con la primera tarea escrita.
- `npm run dist` / `npm run dist:win` (`scripts/dist.cjs`): sin repositorio de GitHub empaqueta sin canal de actualizaciones en lugar de fallar al final. Primer instalador generado: `ZHASKA-Setup-0.1.0.exe` (162 MB).
- Pruebas de la app **empaquetada** (`npm run test:package`) y de **actualización 0.1.0 → 0.1.1** (`npm run test:update`), también en el CI. Flujo de publicación al etiquetar (`release.yml`, borrador en GitHub Releases). Guía de validación en Windows (`docs/WINDOWS.md`) con canal local (`scripts/serve-updates.ps1`).

### Corregido (Fase 10)
- Los adjuntos no funcionaban en la app instalada: los `worker_thread` no leen el ASAR. La extracción corre ahora en un proceso aparte (utilityProcess), el hilo del OCR se lanza desde `app.asar.unpacked` y pdfjs se carga en modo Node. Si el proceso se cae, el trabajo se reintenta una vez.
- El instalador ya no incluye dos veces la interfaz: React, Monaco, xterm y demás pasan a dependencias de desarrollo (ya van compilados por Vite). Tampoco incluye los binarios nativos de otras plataformas.

### Añadido — Fase 9 (23-11-2026)
- **Restaurar copias desde la interfaz** (Configuración → Privacidad y datos): lista de copias con su fecha y motivo, comprobación antes de restaurar y reinicio automático. Antes de sustituir nada se guarda una copia «Antes de restaurar» para poder deshacerlo. Aviso al volver a abrir.
- **Exportar e importar** todos los datos en un archivo `.zhaska` (con o sin adjuntos); importar también acepta una copia `.db` suelta. Se muestra un resumen antes de aplicar y se guarda una copia «Antes de importar».
- **Archivos protegidos editables** (añadir, quitar, restaurar predeterminados). Ahora también se pregunta antes de **leerlos**, también con comandos, y su contenido no aparece en las búsquedas. Nuevos por defecto: `*.p12`, `*.pfx`, `id_ed25519*`, `.npmrc`.
- **Carpetas autorizadas** por proyecto: el agente puede leerlas sin preguntar, nunca modificarlas. Cualquier otra lectura fuera del proyecto pide permiso para esa ruta concreta.
- **Retención de instantáneas** del agente (7 a 365 días, 30 por defecto) con espacio usado y «Liberar espacio ahora»; las de cambios pendientes se conservan siempre.
- `docs/SECURITY.md`: modelo de amenazas, lista de comprobación de Electron punto por punto y auditoría de los 88 canales IPC.
- Prueba de restauración de punta a punta con tres arranques reales de la app: `npm run test:restore`.

### Seguridad — Fase 9
- **CommandPolicy revisada**: `find -delete` se consideraba seguro; un salto de línea podía colar un segundo comando; `/bin/rm`, `\rm`, `VAR=1 rm`, `xargs rm`, bloques `{ }` de PowerShell, `-EncodedCommand` y los scripts de `package.json` escapaban al análisis. Todo corregido y con pruebas. Además, los borrados por comando preguntan siempre (también en modo autónomo) y ya no salta la alarma con `> /dev/null` o `2>&1`.
- Aprobar con «Siempre aquí» un borrado creaba una regla que permitía después cualquier escritura sin preguntar. Corregido.
- Abrir o crear proyectos solo con carpetas elegidas por ti (selector o arrastrar); nunca la raíz del disco, tu carpeta personal completa, carpetas del sistema o de credenciales, ni los datos de ZHASKA.
- `settings.set` solo acepta ajustes conocidos y con su tipo; Ollama solo puede estar en este equipo. `messages.add` ya no admite mensajes de sistema.
- Sandbox para todo contenido web, bloqueo global de `<webview>`, ventanas nuevas y redirecciones; CSP también como cabecera HTTP.

### Corregido (Fase 9)
- La tarjeta de aprobación ya no ofrece «Siempre aquí» para lo que se pregunta cada vez (peligroso, protegido, fuera del proyecto, borrados), donde el botón no tenía efecto.
- Un paso denegado o fallido ya no aparece en el chat como «Leído» o «Editado»: muestra «Denegado» o «Falló».
- La ubicación de un proyecto nuevo o clonado se elige con el selector (antes se podía escribir a mano una ruta).

### Cambiado (Fase 9)
- Las copias de seguridad son archivos SQLite autónomos (sin `-wal`/`-shm`).
- Las rutas absolutas que existen en el disco ya no se convierten en relativas al proyecto (para poder leer carpetas autorizadas); «/src/App.tsx» se sigue interpretando como del proyecto.

### Añadido — Fase 8 (23-11-2026)
- Adjuntos reales: clip, arrastrar y soltar, pegar capturas; varios a la vez; quitar antes de enviar. Se guardan solo en este equipo, fuera del proyecto (migración 5: `attachments` y `message_attachments`).
- Extracción local en un proceso aparte: PDF, PDF escaneado con OCR (español e inglés incluidos), DOCX, XLSX (todas las hojas), CSV/TSV, texto y código con detección de codificación, imágenes (miniatura, OCR) y ZIP seguro.
- Vista previa: texto por páginas, hojas en pestañas, árbol del ZIP con lo rechazado y su motivo, imagen con el texto reconocido.
- Imágenes con la visión de Gemma 4; modelo de visión auxiliar para modelos sin visión (Configuración → Modelos → Imágenes adjuntas).
- Herramienta del agente `read_attachment` (solo lectura, con offset y archivos dentro de un ZIP) y paso «Adjuntos en el contexto» en el panel de actividad.
- Dependencias: pdfjs-dist 6.5, mammoth 1.13, read-excel-file 9.3, tesseract.js 7 con @tesseract.js-data/eng y spa, yauzl 3.4 y @napi-rs/canvas 1.2.

### Añadido — Fase 7 (23-11-2026)
- Terminal real (node-pty/ConPTY): PowerShell, cmd o Git Bash; varias sesiones por proyecto, redimensionado y reinicio. Pestañas Problemas (errores de la última comprobación del agente, con salto a archivo y línea) y Agente (salida de sus comandos).
- Propuestas del agente en el editor: vista «Cambios» con diff en línea, «Cambio 1 de N · propuesto por ZHASKA» y aceptar/rechazar por fragmento o por archivo. Marcas A/M/D en pestañas y explorador.
- Plantillas React + Vite y Next.js con registro en vivo, instalación opcional, Git y ZHASKA.md; clonar repositorios.
- Prueba real de que `npm run dev` funciona dentro de la terminal (`ZHASKA_EVAL_TEMPLATES=1`).

### Corregido (Fase 7)
- El agente ya no falla al editar si copia el fragmento con otra sangría o con los números de línea de `read_file`; si falla, «Ver salida» muestra qué buscó.
- La tarjeta de cambios del chat se actualiza al aceptar o rechazar desde el editor.
- Las barras de acciones ya no se cortan cuando el editor o el chat son estrechos.
- El panel de terminal ya no se redimensiona en bucle (unas 60 veces por segundo) cuando no hay ninguna sesión abierta.
- `posix_spawnp failed` al abrir la terminal en macOS (permiso del `spawn-helper` de node-pty, ahora en `postinstall`).

### Añadido — Fase 6 (22-11-2026)
- Registro de actividad del agente en SQLite (migración 4) y reconstrucción del panel al volver a una conversación o pulsar un paso de una respuesta antigua.
- Panel de actividad rediseñado según la referencia: «Tarea actual», pasos agrupados con etiquetas en curso/completado, comandos, errores, salida, plan «En cola» y aprobación integrada.
- «Pausar agente» / «Reanudar» reales y «Registro completo» con todos los eventos.
- Prueba de humo con límites de tiempo (nunca se queda colgada) y marcas de progreso; ahora 34 comprobaciones.

### Corregido (Fase 6)
- El panel ya no agrupa pasos que terminaron de forma distinta (fallido + denegado).
- La terminal del agente ya no repite su cabecera al reconstruir una tarea.
- El agente interpreta «/archivo» como la raíz del proyecto (PathGuard sigue impidiendo salir).

### Añadido — Descarga alternativa de modelos (22-11-2026)
- Si el servidor de descargas de Ollama no es accesible, ZHASKA descarga la misma versión oficial de Google desde Hugging Face y la prepara con el renderer/parser de Gemma 4 para conservar herramientas y razonamiento. Ajuste «Origen de las descargas» (Automático · Solo Ollama · Hugging Face).

### Corregido
- La descarga ya no se anuncia como terminada antes de que el modelo esté listo.
- Mensaje claro en español cuando falla la conexión con el servidor de descargas.
- El banco de pruebas mide llamadas válidas (herramienta existente y argumentos correctos) en lugar de exigir una herramienta concreta.

### Añadido — Fase 5 (22-11-2026) · evaluación: 5/6 tareas con Gemma 4 12B
- Agente de programación: bucle con herramientas nativas o JSON estructurado, validación y auto-reparación, límites, detección de bucles, compactación de contexto, verificación automática y cancelación.
- 13 herramientas: estructura, listar, leer, buscar, configuración, plan, crear, editar (búsqueda/sustitución exacta, conserva CRLF), eliminar, ejecutar comando, instalar dependencias, pruebas y comprobación de errores.
- CommandPolicy y ejecutor de comandos (tiempo límite, salida acotada, cancelación del árbol de procesos, sin variables secretas).
- Permisos: niveles de autonomía, política por acción, confirmación obligatoria para lo peligroso, protegido o fuera del proyecto, reglas «Siempre aquí» (Configuración → Agente y permisos).
- Registro de cambios con copias previas, aceptar/rechazar por archivo o todo, diff del cambio (migración 3: tareas, cambios y reglas).
- Chat con modo «Agente» o «Solo chat»; pasos en vivo; panel de actividad, aprobaciones y terminal con eventos reales.
- Evaluación con modelo real: `npm run eval:agent` (variable `ZHASKA_EVAL_MODEL`).

### Cambiado
- PathGuard, errores y servicio de archivos movidos a `src/core/` (compartidos por main y el Agent Host).

### Añadido — Fase 4 (22-11-2026, pendiente de validar en Windows)
- Cliente de Ollama sin dependencias (NDJSON en streaming, cancelación), `ModelProvider` + `OllamaProvider`, Agent Host en `utilityProcess` con reinicio automático.
- Supervisor de Ollama (estado cada 3 s, iniciar/detener, registros, instalación en Windows con firma verificada) y detección de hardware (CUDA/Metal/CPU, VRAM, RAM, disco).
- Modelos: listar, descargar con progreso por fases, cancelar, eliminar, cargar/liberar; prueba de funcionamiento.
- Chat real: streaming, estados reales (cargando · contexto · razonando · generando), detener con Esc, errores con acción directa, métricas por respuesta, uso de contexto, Markdown seguro.
- Banco de pruebas con historial en SQLite (migración 2) y exportación a Markdown.
- Pantallas de la referencia: Ollama, Descargar Gemma 4, selector de modelo, indicador de conexión, tarjeta del modelo, asistente de primera ejecución.

### Añadido — Fase 3 (22-11-2026)
- Contrato IPC tipado con zod (`src/shared/ipc`), preload con lista blanca de canales y eventos, resultados `{ ok, data | error }` con códigos, validación del origen; protocolo `app://zhaska`; instancia única; datos de desarrollo separados (`ZHASKA-dev`).
- SQLite integrado (`node:sqlite`) con migraciones, repositorios de proyectos, conversaciones, mensajes y ajustes; copias de seguridad diarias, previas a migración y manuales (Configuración → Privacidad).
- PathGuard y servicio de archivos: listar, leer (binarios, BOM, EOL, límite 5 MB), escritura atómica con detección de conflictos, crear, renombrar, mover a la papelera, mostrar en el sistema; watcher del proyecto.
- Proyectos reales: abrir carpeta (diálogo, ⌘/Ctrl+O o arrastrar), crear proyecto (Vacío, Git, `ZHASKA.md`), recientes, reabrir el último al iniciar.
- Explorador como panel propio con creación y renombrado en línea, menú contextual y confirmación; editor con guardado (⌘/Ctrl+S), aviso de conflictos, archivos no editables y confirmación al cerrar con cambios.
- Conversaciones persistentes por proyecto, agrupadas por fecha (Hoy, Ayer, Últimos 7 días…), con renombrar y eliminar.
- Ajustes persistidos en SQLite; Configuración reorganizada según la referencia de diseño, con niveles de autonomía y permisos por acción del agente.
- Diseño de referencia del usuario (`docs/design/referencia-forja.pdf`): tokens de color, Geist/Geist Mono, radios, barra de título de 40 px, sidebar, diálogo "Nuevo proyecto".
- Tests: 52 unitarios (Vitest) y prueba de humo de la app real (`npm run smoke`, 22 comprobaciones). Workflow de CI para Windows y macOS.

### Cambiado
- `better-sqlite3` sustituido por `node:sqlite` (sin módulos nativos para la base de datos).
- Inter/JetBrains Mono sustituidas por Geist/Geist Mono; acento violeta según la referencia.
- Modos de permisos "Solo lectura / Preguntar / Automático" sustituidos por los niveles de la referencia: "Preguntar siempre / Equilibrado / Autónomo".

### Añadido — Fase 2 (22-11-2026)
- Proyecto Electron 45 + electron-vite 6 + React 19 + TypeScript 7 + Tailwind 4.
- Ventana segura: contextIsolation, sandbox, sin nodeIntegration, CSP estricta en producción, navegación y ventanas emergentes bloqueadas, permisos web denegados. Puente `window.zhaska` mínimo.
- Sistema de diseño en código (tokens en `@theme`), fuentes Inter y JetBrains Mono empaquetadas, logotipo ZHASKA.
- Componentes base: botones (con estado "bloqueado hasta la Fase N"), tooltips, menús y menús contextuales, diálogos, notificaciones, interruptores, selectores.
- Layout de 4 zonas redimensionables y plegables con presets y tamaños persistentes; barra de título personalizada; barra de estado.
- Chat: mensajes, chips de herramientas enlazados al panel de actividad, bloques de código resaltados con Monaco, tarjeta de cambios, composer con menciones `@`, adjuntos (selector, arrastrar, pegar) y vista previa de imágenes.
- Panel de actividad: fases, estados, duraciones, salida desplegable, aprobación de comandos, métricas; reducer de `AgentEvent` compartido con el futuro agente.
- Editor Monaco local con tema propio, pestañas, vista diff y marcas de líneas del agente; terminal xterm.js (pestaña del agente y vista previa de la shell).
- Configuración (6 secciones), gestor de modelos con encaje estimado para RTX 5060 8 GB + 16 GB RAM, asistente de primera ejecución (vista previa), pantalla de bienvenida, paleta de comandos.
- Datos de demostración claramente marcados (`src/renderer/demo/`).

### Cambiado
- Nombre comercial: ZHASKA. Perfil Calidad (26B-A4B) descartado con 16 GB de RAM. Sin firma de código por ahora.

### Añadido — Fase 1 (22-11-2026)
- Arquitectura completa (`ARCHITECTURE.md`): procesos Main / Agent Host (`utilityProcess`) / Renderer, contrato IPC tipado con zod, esquema SQLite, AI Engine con interfaz de proveedor y doble protocolo de herramientas (nativo / JSON estructurado), 14 herramientas, eventos de actividad, PathGuard, Permission Broker, CommandPolicy, ZIP seguro, checkpoints y diff, onboarding, instalador y updates.
- Análisis de Gemma 4 en Ollama para RTX 5060 8 GB (`docs/MODELS.md`); modelo por defecto propuesto: `gemma4:12b-it-qat`.
- Sistema de diseño (`docs/DESIGN.md`) y maqueta visual estática (`docs/design/mockup.html`).
- Roadmap por fases con criterios de salida (`ROADMAP.md`).
