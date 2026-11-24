# Roadmap — ZHASKA

Cada fase termina con **criterios de salida verificables**. No se avanza a la siguiente sin cumplirlos.
Leyenda: ✅ terminada · 🔄 en curso · ⏳ pendiente

| Fase | Nombre | Estado |
|---|---|---|
| 1 | Análisis y arquitectura | ✅ |
| 2 | Diseño visual (UI completa con datos de demostración) | ✅ |
| 3 | Electron y sistema local (IPC, SQLite, proyectos) | ✅ |
| 4 | Integración con Ollama y Gemma | 🔄 implementada; falta validar en el PC Windows |
| 5 | Agente de programación | ✅ |
| 6 | Actividad en tiempo real | ✅ |
| 7 | Terminal y editor | ✅ |
| 8 | Adjuntos | ✅ |
| 9 | Seguridad y persistencia (endurecimiento) | ✅ |
| 10 | Instalación y actualizaciones | ✅ (instalado y funcionando en el PC Windows, 24-11-2026; falta probar ahí la actualización) |
| 11 | Pruebas y optimización | ✅ Aprobada (24-11-2026) |

**Hito v0.1 "primer agente útil"** = fases 2–7: abrir un proyecto, pedir un cambio a Gemma, verlo trabajar en el panel de actividad, revisar el diff y aceptarlo.
**Hito v1.0** = fases 8–11: adjuntos, endurecimiento, instalador y updates.

---

## Fase 1 — Análisis y arquitectura ✅
Entregables: `ARCHITECTURE.md`, `docs/MODELS.md`, `docs/DESIGN.md`, `docs/design/mockup.html`, este roadmap.
Salida: aprobación del usuario de arquitectura, modelo por defecto, dirección visual y nombre.

## Fase 2 — Diseño visual ✅

**Resultado (22-11-2026).** La interfaz completa funciona dentro de Electron con datos de demostración. Qué es real y qué es simulado:

| Elemento | Estado en la Fase 2 |
|---|---|
| Ventana Electron segura (contextIsolation, sandbox, CSP estricta, sin Node en la UI, permisos web denegados) | **Real** (verificado) |
| Layout de 4 zonas redimensionables/plegables, presets Agente/IDE/Completo, tamaños recordados | **Real** |
| Paleta de comandos (Ctrl+K), atajos, menús contextuales, notificaciones, diálogos | **Real** |
| Editor Monaco (local, sin CDN), pestañas, vista diff, marcas de cambios del agente | **Real**, sobre archivos de demostración en memoria (guardar en disco: Fase 3) |
| Adjuntar archivos (selector, arrastrar y soltar, pegar), tarjetas, límites, vista previa de imágenes | **Real** en la UI; la extracción de contenido llega en la Fase 8 |
| Menciones `@archivo` en el composer | **Real** |
| Ajustes | **Real**, guardados en localStorage hasta la Fase 3 |
| Panel de actividad, chips del chat y pestaña "Agente" de la terminal | Código real (reducer de `AgentEvent` compartido) alimentado por un **guion simulado** (`src/renderer/demo/activityScript.ts`) |
| Proyecto, conversaciones y explorador | **Simulados** (`src/renderer/demo/`), marcados con la etiqueta "DEMO · DATOS SIMULADOS" |
| Envío al modelo, descargas, Ollama, terminal interactiva | Bloqueados con candado e indicación de su fase |

Pendiente detectado: el bundle principal del renderer pesa ~1,3 MB (xterm, iconos); se optimizará con carga diferida en la Fase 11.

Alcance original:
- Andamiaje `electron-vite` + React + TS + Tailwind 4 con una ventana Electron mínima (la UI se ve ya en la app real, no en el navegador).
- Tokens de diseño, fuentes locales, primitivas propias (`Button`, `IconButton`, `Tabs`, `Menu`, `ContextMenu`, `Tooltip`, `Toast`, `Dialog`, `Kbd`).
- Layout de 4 zonas con `react-resizable-panels`, plegado, presets Agente/IDE/Completo y persistencia de tamaños.
- Pantallas: principal, chat (mensajes, chips, bloques de código, tarjeta de cambios, composer con adjuntos), actividad, explorador, editor Monaco (local, tema propio), terminal xterm (visual), ajustes (todas las secciones), gestor de modelos, onboarding, estados vacíos/carga/error.
- Datos de demostración en `src/renderer/demo/`, con una franja visible **"Modo demostración"** en la UI.

**Salida**: la app arranca con `npm run dev`, todas las pantallas navegables, sin botones sin destino (los que dependen de fases futuras aparecen deshabilitados con tooltip "Disponible en la fase N"), 60 fps al redimensionar.

## Fase 3 — Electron y sistema local ✅

**Resultado (22-11-2026).**
- Contrato IPC único con zod, preload con lista blanca, errores estructurados, validación de origen; interfaz servida por `app://zhaska`.
- SQLite integrado (`node:sqlite`): migraciones versionadas, repositorios de proyectos, conversaciones, mensajes y ajustes, copias diarias / previas a migración / manuales.
- PathGuard (rutas relativas, `..`, absolutas, UNC, nombres reservados y ADS de Windows, enlaces simbólicos que salen del proyecto).
- Proyectos reales: abrir carpeta (diálogo o arrastrar), crear (Vacío + Git + `ZHASKA.md` con la descripción), recientes, quitar de recientes sin perder historial, reabrir el último al iniciar.
- Explorador real con carga perezosa, `fs.watch`, crear / renombrar / mover a la papelera; editor que abre y guarda en disco (escritura atómica, BOM, EOL, conflictos si el archivo cambió fuera).
- Conversaciones persistentes por proyecto (crear, renombrar, eliminar; agrupadas por fecha).
- Fundamentos visuales de la referencia de diseño (Forja): paleta, Geist, radios; sidebar, barra de título, explorador como panel, "Nuevo proyecto" y Configuración rediseñados.

**Criterios de salida comprobados**: 52 tests unitarios y prueba de humo de la app real **22/22** (seguridad, IPC, SQLite, archivos, watcher, edición y guardado con el teclado, reapertura tras reiniciar), estable en 3 ejecuciones seguidas.
**CI**: desde el 24-11-2026 `.github/workflows/ci.yml` se ejecuta en `windows-latest` y `macos-latest` en cada push al repositorio [Eskiador/zhaska](https://github.com/Eskiador/zhaska) (detectó dos fallos que solo ocurrían en Windows; ver CHANGELOG). Las *fuses* de Electron se aplican al empaquetar (Fase 10).

Alcance original:
- Ventana segura (contextIsolation, sandbox, CSP, protocolo `app://`, fuses), contrato IPC tipado con zod.
- SQLite (`better-sqlite3`), migraciones, repositorios, backups.
- Proyectos: crear/abrir/renombrar/cambiar, recientes, explorador real con `fs.watch`, lectura/guardado desde el editor.
- Conversaciones y mensajes persistentes por proyecto.
- CI en GitHub Actions `windows-latest` que compila y arranca la app (prueba de humo de módulos nativos).

**Salida**: se cierran y reabren proyectos y conversaciones sin pérdida; tests unitarios de PathGuard y repositorios en verde; build Windows en CI.

## Fase 4 — Ollama y Gemma 🔄

**Estado (22-11-2026).** Implementado y probado en macOS (Apple M4, Ollama 0.30.8): supervisor (detectar, iniciar, detener, instalar en Windows con verificación de firma), detección de hardware, gestión de modelos (listar, descargar con progreso, cancelar, eliminar, cargar/liberar), Agent Host (`utilityProcess`) con `ModelProvider`/`OllamaProvider`, chat real con streaming, cancelación, métricas y títulos automáticos, banco de pruebas (carga, generación, prefill, herramientas nativas y JSON) con historial y exportación a Markdown, y pantallas del diseño (Ollama, Descargar Gemma 4, selector de modelo, indicador de conexión, tarjeta de modelo, asistente de primera ejecución con comprobaciones reales).
Verificado: 62 tests unitarios y prueba de humo 28/28 (incluye chat real con el modelo local y detener una respuesta).
**Pendiente para cerrar la fase**: descargar `gemma4:12b-it-qat` en el PC con RTX 5060, ejecutar el banco de pruebas y añadir los resultados a `docs/MODELS.md`; probar en Windows la instalación automática de Ollama.

Alcance original:
- Supervisor: detectar, instalar (con consentimiento), arrancar, estado en vivo.
- Gestor de modelos: listar, capacidades vía `/api/show`, descargar con progreso, eliminar, seleccionar activo, perfiles (Rápido/Equilibrado/Calidad).
- `OllamaProvider` (streaming, cancelación, métricas) detrás de `ModelProvider`.
- Chat sin herramientas funcionando de extremo a extremo.
- **Banco de pruebas** de modelos y protocolos; ejecutar en el PC con RTX 5060 y fijar el modelo por defecto con datos.

**Salida**: descarga y uso de `gemma4:12b-it-qat` desde la app; métricas reales (tok/s, VRAM vía `/api/ps`) en la barra de estado; informe del banco de pruebas añadido a `docs/MODELS.md`.

## Fase 5 — Agente de programación ✅

**Estado (22-11-2026).** Implementado y probado en macOS:
- `AgentLoop` en el Agent Host con dos protocolos (herramientas nativas de Ollama y JSON estructurado), validación con zod y auto-reparación, límite de pasos, detección de bucles y de fallos seguidos, compactación de contexto, verificación automática tras cambiar código y cancelación en cualquier punto.
- 13 herramientas (`read_attachment` llega con los adjuntos en la Fase 8). `search_code` es una búsqueda propia sin dependencias; ripgrep se valorará en la Fase 11 si hace falta.
- Seguridad: PathGuard, CommandPolicy (seguro / normal / peligroso, red, rutas fuera del proyecto), entorno sin secretos, niveles de autonomía y permisos por acción, archivos protegidos, reglas «Siempre aquí» persistentes y revocables.
- Cambios: copia previa de cada archivo (almacén por hash), registro por tarea, aceptar / rechazar (restaurar) por archivo o en bloque, con aviso si el archivo cambió después, y vista diff.
- Interfaz conectada a los eventos reales: pasos en vivo en el chat y en el panel de actividad, tarjeta de aprobación, salida de comandos en la pestaña "Agente" de la terminal.

**Verificado**: 95 tests unitarios (incluido el bucle con un modelo simulado y la matriz de permisos) y prueba de humo 32/32 con tareas reales del agente (crear tras aprobar, rechazar y restaurar, denegar).
**Criterio de salida cumplido**: `npm run eval:agent` con `gemma4:12b-it-qat` (herramientas nativas) en el Mac M4: **5/6 tareas (83 %)**, objetivo ≥ 80 % (con `llama3` 8B: 2/6). Detalles en `docs/MODELS.md` §5. Queda repetirlo en el PC con Windows.

Alcance original:
- AgentLoop en `utilityProcess`, ContextBuilder, compactación, límites y detección de bucles.
- Protocolos NativeTools y StructuredJSON con validación y auto-reparación.
- Las 14 herramientas, PathGuard, CommandPolicy, PermissionBroker con UI de aprobación, ChangeTracker y checkpoints (la seguridad básica entra **aquí**, no en la fase 9).
- Cancelación limpia en cualquier punto.

**Salida**: suite E2E de tareas reales sobre proyectos de ejemplo (crear componente, corregir error de compilación, añadir dependencia y test) con ≥ 80 % de éxito con el modelo por defecto; ningún acceso fuera del proyecto sin aprobación (tests de path traversal).

## Fase 6 — Actividad en tiempo real ✅

**Resultado (22-11-2026).**
- Cada `AgentEvent` real se guarda en SQLite (`activity_events`, migración 4; la salida de comandos, acotada a 400 líneas por paso). Las tareas interrumpidas al cerrar la app quedan registradas como canceladas con su motivo.
- El panel se reconstruye desde el registro: al abrir una conversación (su última tarea) y al pulsar un paso de una respuesta antigua (su tarea, con el paso resaltado).
- Rediseño según la referencia: tarjeta «Tarea actual» (estado, acciones, leídos, cambiados, líneas), pasos agrupados con etiquetas en curso → completado («Leyendo código → Código leído», «Corrigiendo errores»), comandos como `$ …`, errores en recuadro rojo, «Ver salida», plan pendiente «En cola», aprobación integrada.
- «Pausar agente» real (el bucle espera antes del siguiente paso) y «Registro completo» con todos los eventos y su hora.

**Criterios de salida comprobados**: 103 tests (incluido que el estado reconstruido es idéntico al vivido y el registro de tareas interrumpidas) y, en la app real, la actividad se guarda evento a evento y tras recargar la ventana el panel muestra los mismos pasos.

Alcance original:
- `AgentEvent` → persistencia → panel de actividad: fases, estados, duraciones, salida en vivo, aprobaciones, errores, reconstrucción de tareas antiguas.
- Chips del chat enlazados con pasos; estado del modelo (prefill/razonando/generando).

**Salida**: cada fila del panel corresponde a un evento real registrado (verificable en `activity_events`); recargar la ventana reconstruye el panel idéntico.

## Fase 7 — Terminal y editor ✅

**Resultado (23-11-2026).**
- Terminal real con `node-pty` (ConPTY en Windows): PowerShell por defecto, cmd o Git Bash según Configuración; varias sesiones por proyecto que arrancan en su carpeta, redimensionado, «Reiniciar terminal» y se cierran al cerrar el proyecto. La salida va en lotes de 16 ms para no saturar la interfaz.
- Pestañas de la referencia: sesiones del usuario · **Problemas** (errores de la última comprobación o prueba fallida del agente, con salto al archivo y línea) · **Agente** (salida real de sus comandos, solo lectura).
- Propuestas del agente dentro del editor: vista «Cambios N» con diff en línea (original guardado antes de la tarea ↔ archivo actual), «Cambio 1 de N · propuesto por ZHASKA», anterior/siguiente, **Rechazar** o **Aceptar** cada fragmento y también el archivo entero. Rechazar un fragmento lo deshace y guarda; si el archivo vuelve a ser el original, el cambio queda como rechazado. Marcas A/M/D en pestañas y explorador, y «Revisar cambios del agente» en su menú.
- Nuevo proyecto: plantillas **React + Vite** y **Next.js** (ejecutan el comando oficial sin shell, con registro en vivo; opcional `npm install`, Git y ZHASKA.md) y **Clonar repositorio** (URL https o git@ validada).
- El agente tolera `old_string` con otra sangría o copiado con los números de línea de `read_file` (sin adivinar si hay varias coincidencias); si una edición falla, «Ver salida» muestra el texto que buscó.
- `scripts/postinstall.cjs` da permiso de ejecución al `spawn-helper` de node-pty en macOS/Linux.

**Criterios de salida comprobados**:
- `npm run dev` de un proyecto React + Vite recién creado funciona dentro de la terminal y la página responde (`ZHASKA_EVAL_TEMPLATES=1`, 4/4 junto con plantillas y clonado).
- Flujo de diff completo en la app real con Gemma 4: el agente corrige `src/math.js`, la vista «Cambios» lo muestra y «Rechazar» deja el archivo en el disco igual que el original y sin cambios pendientes; aceptar/rechazar archivo completo con restauración verificada por hash (prueba de humo).
- 107 tests unitarios (incluida una shell real) y prueba de humo de la app compilada.

Alcance original:
- PTY real (PowerShell por defecto, cmd, Git Bash si existe), varias sesiones, historial, redimensionado, pestaña "Agente" con la salida de sus comandos.
- Monaco completo: pestañas, búsqueda, diagnósticos, guardado, DiffEditor para changesets, aceptar/rechazar por archivo y hunk.

**Salida**: `npm run dev` de un proyecto de usuario funciona dentro de la terminal; flujo completo de diff aceptar/rechazar con restauración verificada por hash.

## Fase 8 — Adjuntos ✅

**Resultado (23-11-2026).**
- Adjuntar con el clip, arrastrando sobre el chat o pegando (capturas); varios a la vez y de distintos formatos; quitar antes de enviar. Cada archivo se guarda en local (fuera del proyecto, por sha256) y se procesa al momento en un `worker_thread`.
- Tarjetas con icono, nombre, extensión, tamaño, estado real (subiendo · progreso como «Reconociendo texto (OCR) en la página 2 de 5» · listo · error con motivo) y miniatura de las imágenes. Vista previa: texto extraído por páginas, hojas de Excel en pestañas con tabla, árbol del ZIP con lo rechazado y por qué, imagen con su OCR.
- Extracción local: PDF (pdfjs 6) y PDF escaneado con OCR (tesseract, español+inglés incluidos), DOCX, XLSX con varias hojas, CSV/TSV, texto y código con detección de codificación, PNG/JPG/WEBP/GIF/SVG y ZIP seguro.
- Imágenes con visión nativa de Gemma 4; si el modelo no tiene visión, modelo de visión auxiliar local (automático, elegido o ninguno) con la descripción marcada como tal; si no hay ninguno, aviso explícito. Nunca se simula.
- El agente recibe el contenido en su primer mensaje y lee el resto con `read_attachment` (también archivos dentro de un ZIP). Los adjuntos son de solo lectura: ninguna herramienta puede escribir en el almacén. El panel de actividad muestra el paso «Adjuntos en el contexto».
- Al enviar, main comprueba que todos estén listos; los adjuntos quedan en el historial de la conversación y en el diálogo «Adjuntos».

**Criterios de salida comprobados**:
- Corpus de pruebas generado en las pruebas (sin binarios opacos): ZIP malicioso (`../`, ruta absoluta, enlace simbólico, bomba 1000:1, ejecutable, nombre reservado, ZIP anidado, 10 001 entradas), PDF con texto, **PDF escaneado** leído con OCR (confianza > 70 %), **XLSX con varias hojas**, DOCX, CSV con comillas y saltos de línea, texto en UTF-16 y Windows-1252, PNG/WEBP/SVG, contenido que no coincide con la extensión → 15 pruebas.
- Ningún adjunto es modificable por el agente: `read_attachment` es la única herramienta que los toca y es de lectura; no puede salir de `unzipped/` (prueba con `../../extracted.txt`).
- Evaluación del agente con Gemma 4: nueva tarea «Leer un adjunto largo» (el dato está a 36 000 caracteres, fuera del mensaje) superada con `read_attachment` en 1 paso y 7 s.
- Prueba de humo de la app compilada: 42/42 (5 comprobaciones nuevas de adjuntos).
- App real con Gemma 4: cinco adjuntos por el selector de archivos, procesados en < 1 s; preguntado por la captura y el Excel, respondió «El error es "listen EADDRINUSE" (puerto 3000 ocupado). El importe de enero según ventas.xlsx fue de 4321.» en 65 s.

Alcance original:
Selector, drag & drop, tarjetas, vista previa, extracción PDF/DOCX/XLSX/CSV/TXT/MD, OCR, imágenes (visión nativa o modelo auxiliar), ZIP seguro, `read_attachment`.

**Salida**: corpus de pruebas (incluye ZIP malicioso, PDF escaneado, XLSX con varias hojas) procesado correctamente; ningún adjunto modificable por el agente.

## Fase 9 — Seguridad y persistencia ✅

**Resultado (23-11-2026).** Detalle completo en [docs/SECURITY.md](docs/SECURITY.md).
- **Auditoría del IPC** (88 canales): abrir o crear proyectos solo con carpetas elegidas en el selector, arrastradas a la ventana o ya conocidas; nunca carpetas sensibles (raíz del disco, carpeta personal completa, sistema, credenciales, datos de ZHASKA). `settings.set` con lista blanca de claves y tipos (Ollama solo en este equipo). `messages.add` sin mensajes de sistema. Sandbox global, bloqueo de `<webview>`, ventanas y redirecciones en cualquier webContents, CSP también como cabecera.
- **CommandPolicy revisada**: 11 huecos cerrados (entre ellos `find -delete` considerado seguro, comandos ocultos tras un salto de línea, `/bin/rm`, `xargs rm`, `-EncodedCommand` y scripts de `package.json` que borraban), menos falsos positivos (`> /dev/null`, `2>&1`) y los borrados por comando preguntan siempre. También se corrigió que «Siempre aquí» sobre un borrado concedía cualquier escritura.
- **Archivos protegidos** editables; se pregunta también antes de leerlos y no aparecen en las búsquedas.
- **Carpetas autorizadas** por proyecto (solo lectura para el agente); cualquier otra lectura fuera del proyecto pide permiso para esa ruta; las herramientas de archivos solo modifican el proyecto.
- **Copias**: lista en Configuración → Privacidad y datos con «Restaurar…»; se comprueba la copia, se guarda «Antes de restaurar» y se aplica al reiniciar. Copias como archivos autónomos.
- **Exportar / importar** en un archivo `.zhaska` (con o sin adjuntos) o desde una copia `.db`, con resumen antes de aplicar y copia «Antes de importar».
- **Retención de instantáneas** del agente (30 días por defecto, configurable, «Liberar espacio ahora»); las de cambios pendientes se conservan siempre.

**Criterios de salida comprobados**:
- **Checklist de seguridad de Electron**: 19 de 20 puntos aplicados y comprobados ([docs/SECURITY.md §2](docs/SECURITY.md)). El que falta (n.º 19, los fusibles de Electron) solo existe en el binario empaquetado y se aplica con el instalador (Fase 10).
- **Prueba de restauración de backup**: `npm run test:restore` arranca la app real tres veces sobre los mismos datos: restaura una copia (los datos vuelven al estado guardado y queda la copia «Antes de restaurar»), exporta, importa y vuelve a comprobarlo, con el aviso en la interfaz → 13/13. También en el CI de Windows y macOS.
- Pruebas automáticas: 222 (100 nuevas: política de comandos con los trucos encontrados, carpetas sensibles en macOS y Windows, lecturas fuera del proyecto con enlaces simbólicos, ajustes, el agente en modo autónomo con `.env` y carpetas externas, restaurar con copia dañada, ida y vuelta de exportar/importar y 9 archivos de importación manipulados).
- Prueba de humo de la app compilada: 59/59 (17 comprobaciones nuevas) y ningún error en la consola de la interfaz.
- App real con Gemma 4 en modo **autónomo**: leyó el archivo de una carpeta autorizada sin pedir permiso y respondió bien («El valor de IVA es 0.21 y el de DESCUENTO_SOCIO es 0.15», 54 s); al pedirle el `.env` del proyecto, pidió permiso («Leer .env · Archivo protegido»), se denegó y respondió sin revelar nada.

Alcance original:
Auditoría de IPC, revisión de CommandPolicy, archivos protegidos, directorios autorizados, backups y restauración desde la UI, exportar/importar datos, retención de checkpoints.

**Salida**: checklist de seguridad de Electron completa; prueba de restauración de backup.

## Fase 10 — Instalación y actualizaciones ✅

**Resultado (23-11-2026).** Guía de prueba en el PC: [docs/WINDOWS.md](docs/WINDOWS.md).
- **Instalador NSIS** (electron-builder 26.18): por usuario y sin administrador, en español, con elección de carpeta, accesos directos, icono y barras laterales propias; el desinstalador no borra los datos. Programa en `%LOCALAPPDATA%\Programs\ZHASKA`, datos en `%APPDATA%\ZHASKA`.
- **Empaquetado**: ASAR con integridad y **fusibles** (lista de seguridad de Electron 20/20); binarios nativos y OCR fuera del ASAR; sin los binarios de otras plataformas; la interfaz ya no se empaqueta dos veces (React, Monaco… pasan a dependencias de desarrollo). App de Windows: ~440 MB sin comprimir, la mayor parte Electron.
- **Actualizaciones** (electron-updater 6.8): solo con permiso y tras el asistente; descargar (verificada con sha512) e instalar los decide el usuario; copia «Antes de actualizar»; aviso «ZHASKA se actualizó». Sin repositorio, la app dice que no están configuradas. Publicación al etiquetar con `release.yml` (borrador en GitHub Releases).
- **Asistente inicial completo**: requisitos, Ollama, GPU, disco, modelos, Node/Python/Git (solo informa), descarga, prueba de respuesta, **prueba real de herramientas** y primer proyecto con una tarea para el agente.
- Problema encontrado al probar la app empaquetada: los adjuntos fallaban porque los `worker_thread` no leen el ASAR. Ahora la extracción corre en un `utilityProcess` (más aislado), el OCR se lanza desde la copia desempaquetada y pdfjs se carga en modo Node.

**Criterios de salida comprobados**:
- **App empaquetada** (`npm run test:package`, ejecutable real controlado desde fuera porque los fusibles impiden inyectar código): fusibles e integridad en el binario, interfaz sin Node, adjuntos (OCR al 96 %, PDF, PDF escaneado, Word, Excel), terminal, el agente con Gemma 4 creando un archivo (10–38 s) y copias → 13/13 en macOS. En `ZHASKA.exe` (generado desde el Mac) se comprobaron los fusibles y que lleva solo los binarios de Windows x64.
- **Actualización de 0.1.0 a 0.1.1 conservando datos** (`npm run test:update`): la 0.1.0 encuentra la 0.1.1 en un canal local, la descarga y verifica su sha512; la 0.1.1 arranca sobre los mismos datos, detecta la actualización y conserva ajustes, proyectos, adjuntos y copias → 24/24.
- **Asistente** en la app real con Gemma 4: «Respondió listo en 7,3 s · 18 tok/s»; prueba de herramientas `list_files({"path":"src"})` → «El archivo dentro de la carpeta `src` es `calculadora.ts`» en 6,6 s; el proyecto de ejemplo se crea con la primera tarea escrita.
- Pruebas automáticas: 231 (9 nuevas), prueba completa 59/59, restauración 13/13.
- **Instalador generado** en el Mac (con Rosetta 2, instalada el 23-11-2026: el generador NSIS de electron-builder para macOS es x86-64): `dist/ZHASKA-Setup-0.1.0.exe`, 162 MB, NSIS 3 Unicode. Revisado por dentro: `ZHASKA.exe` con información de versión de ZHASKA, fusibles e integridad del ASAR; solo binarios de Windows x64; idiomas español e inglés; desinstalador. También los dos instaladores de prueba de actualización (0.1.0 con canal local y 0.1.1 con su `latest.yml` y sha512).
- **Pendiente en el PC con Windows**: instalación limpia → asistente → primera tarea, y la actualización real con el instalador (docs/WINDOWS.md §4).

Alcance original:
NSIS, icono y marca, onboarding completo con verificación paso a paso, electron-updater con GitHub Releases, firma de código (según decisión).

**Salida**: instalación limpia en un Windows sin Node/Python/Git → onboarding → primera tarea del agente; actualización de vX a vX+1 conservando datos.

## Fase 11 — Pruebas y optimización ✅

**Resultado (24-11-2026). Aprobada el 24-11-2026.** Detalle técnico en ARCHITECTURE §6.5 y §14.

**Rendimiento** (app empaquetada, `npm run test:perf`, Mac M4):
- Arranque hasta la interfaz usable: **0,34 s** (objetivo < 2 s).
- Proyecto de **50 000 archivos**: abrir 0,06 s; desplegar una carpeta de 2 000 archivos 178 ms (se pintan por tandas de 500); **buscar por nombre en todo el proyecto** 98 ms (nuevo índice; antes la paleta solo veía carpetas abiertas); CPU en reposo 0 %.
- La búsqueda en el contenido del agente se cortaba a los 5 000 archivos y no encontraba lo que hubiera después: ahora recorre los 50 000 en ~2 s.

**Memoria**: 583 → **487 MB** en reposo (el proceso del agente arranca con el primer uso; el de adjuntos se cierra tras 2 min sin trabajo). El proceso principal usa 13 MB de JavaScript: el resto es la base de Chromium. Visible en Configuración → Acerca de → Rendimiento.

**Larga duración del agente** (`tests/eval/long.eval.ts`: tres tareas encadenadas con historial sobre un proyecto con pruebas reales, comprobadas con pruebas ocultas). La prueba destapó fallos que las tareas cortas no mostraban; se midieron con el registro de cada conversación y se corrigieron uno a uno:
- El control anti-bucles impedía el ciclo «editar → probar → corregir» más de dos vueltas.
- Gemma intentaba añadir al final anclando en «}», reescribir bloques línea a línea, olvidaba `path`, repetía ediciones ya hechas y a veces devolvía respuestas vacías que se tomaban como final.
- Nuevas defensas: `write_file`, interpretación de «añadir al final», errores que dicen qué falta, avisos antes de detener, temperatura algo mayor tras una repetición.
- Resultado con Gemma 4 12B: de **0/3** al principio a **3/3** (9, 7 y 1 pasos; 7,4 min).

**Ajuste de prompts por modelo** (medido, no supuesto): con Gemma 4 E4B, prompt completo **6/7** frente a compacto **4/7** → todos los modelos usan el completo; a los de ≤ 5B se les limita la temperatura. A ningún modelo se le ofrecen herramientas bloqueadas o que no aplican. Gemma 4 12B en las 7 tareas cortas: 5/7 (los dos fallos fueron del modelo: renombró a otro nombre y una vez se detuvo sin editar).

**Pendiente en el PC con Windows**: `npm run test:perf` sobre `dist/win-unpacked` y las evaluaciones del agente con la RTX 5060.

Alcance original:
Rendimiento (arranque < 2 s, proyecto de 50 000 archivos navegable), memoria, pruebas de larga duración del agente, ajuste de prompts por modelo.

---

## Decisiones tomadas (22-11-2026)
- **Nombre comercial**: ZHASKA.
- **RAM del PC**: 16 GB → perfiles Rápido (`gemma4:e4b-it-qat`) y Equilibrado (`gemma4:12b-it-qat`, por defecto). Calidad (26B-A4B) no se ofrece en este equipo.
- **Firma de código**: no por ahora. El instalador no irá firmado: Windows SmartScreen mostrará "Windows protegió su PC" → *Más información* → *Ejecutar de todas formas*. Se documentará en el README de instalación. electron-updater funciona sin firma (no se configura `publisherName`).

## Decisiones pendientes
Ninguna.

**Repositorio (24-11-2026)**: [github.com/Eskiador/zhaska](https://github.com/Eskiador/zhaska), público (las actualizaciones automáticas desde un repositorio privado exigirían un token dentro de la app). CI en cada push; al etiquetar `vX.Y.Z`, `release.yml` genera el instalador y un borrador de versión.

## Más allá de la v1 (no planificado aún)
Búsqueda semántica con embeddings locales, proveedores externos opcionales (API compatible OpenAI), sandbox de ejecución, tema claro, multiventana, integración Git avanzada (commits/PR asistidos).
