# Arquitectura — ZHASKA

> Estado: **Fases 1–3 completadas; 4 y 5 implementadas** (Ollama, chat y agente con herramientas), pendientes de validar con Gemma 4 en Windows. Las secciones describen el diseño objetivo; lo ya implementado se indica en ROADMAP.md.
> Referencia visual: [`docs/design/referencia-forja.pdf`](docs/design/referencia-forja.pdf) (ver docs/DESIGN.md §0).
> Nombre comercial: **ZHASKA** (decidido el 22-11-2026). Equipo de referencia: RTX 5060 8 GB, Ryzen 7 5800X, 16 GB RAM.
> Fecha de referencia de versiones: 22-11-2026.

---

## 1. Resumen de requisitos

ZHASKA es un IDE de escritorio para Windows, local-first, cuyo núcleo es un **agente de programación propio** que usa modelos locales a través de Ollama (Gemma 4 por defecto). Los requisitos se agrupan en siete bloques:

| Bloque | Requisitos clave | Dónde se resuelve |
|---|---|---|
| Agente | Ciclo herramienta→resultado→decisión, corrección de errores, verificación | §6 AI Engine |
| Transparencia | Panel de actividad alimentado por eventos **reales** | §6.6 Eventos |
| IDE | Monaco, xterm.js, explorador, pestañas, diff | §4 Renderer |
| Modelos | Detectar/instalar/arrancar Ollama, descargar/borrar modelos, métricas | §7 Ollama |
| Adjuntos | PDF/DOCX/XLSX/CSV/imágenes/ZIP, separados de los archivos del proyecto | §8 |
| Seguridad | Aislamiento Electron, path guard, permisos, comandos controlados | §9 |
| Distribución | Instalador NSIS, auto-update por GitHub Releases, datos separados | §11 |

Requisitos no funcionales que condicionan el diseño:

- **Offline** tras la instalación: nada se carga de CDNs (Monaco, fuentes, datos OCR van empaquetados).
- **UI fluida** con proyectos grandes: ningún trabajo pesado en el renderer ni en el hilo principal de Electron.
- **Independencia del modelo**: el agente habla con una interfaz de proveedor, nunca con Ollama directamente.
- **Hardware objetivo**: RTX 5060 8 GB VRAM + Ryzen 7 5800X + 16 GB RAM. El diseño no puede asumir que el modelo cabe entero en GPU.

---

## 2. Stack tecnológico (versiones verificadas en npm el 22-11-2026)

| Componente | Paquete | Versión | Justificación |
|---|---|---|---|
| Escritorio | `electron` | 45.4.x (Node 24) | Requisito |
| Build | `electron-vite` | 6.x | Vite para main/preload/renderer en un único pipeline, HMR |
| UI | `react` | 19.x | Requisito |
| Bundler | `vite` | 8.x | Requisito |
| Lenguaje | `typescript` | 7.x (fallback 6.x) | Requisito. TS 7 es el compilador nativo; si alguna herramienta no lo soporta se fija 6.x solo para `typecheck` |
| Estilos | `tailwindcss` | 4.x | Requisito; tokens en CSS variables (§ DESIGN.md) |
| Iconos | `lucide-react` | 1.x | Requisito |
| Editor | `monaco-editor` + `@monaco-editor/react` | 0.57 / 4.7 | Requisito. **Cargado localmente**, nunca desde CDN |
| Terminal | `@xterm/xterm` + addons fit/search/web-links | 6.x | Requisito |
| PTY | `node-pty` | 1.1.x | Única forma fiable de tener una shell interactiva real (ConPTY en Windows) |
| Base de datos | `node:sqlite` (integrado en Electron 45 / Node 24) | SQLite 3.54 | Síncrono, WAL, FTS5 y backup en línea **sin módulo nativo**: se descartó `better-sqlite3` en la Fase 3 porque obligaba a recompilar para cada versión de Electron y para Windows |
| Validación | `zod` | 4.x | Validar IPC, argumentos de herramientas y eventos con un solo esquema |
| Estado UI | `zustand` | 5.x | Estado global ligero sin boilerplate |
| Paneles | `react-resizable-panels` | 4.x | Paneles redimensionables/plegables accesibles; evita reimplementarlo |
| Markdown chat | `react-markdown` (+ `remark-gfm`) | 10.x | Render seguro (sin HTML crudo). El resaltado de bloques de código usa `monaco.editor.colorize` (cero dependencias extra, mismo tema que el editor) |
| PDF | `pdfjs-dist` | 6.5 | Texto y dibujo de páginas escaneadas para OCR. La versión 6 ya no evalúa código del PDF; se usa sin FontFace ni fuentes del sistema |
| DOCX | `mammoth` | 1.13 | DOCX → texto |
| XLSX | `read-excel-file` | 9.3 | Todas las hojas con sus valores. Se descartan `xlsx` (SheetJS: la versión de npm está abandonada y la oficial se distribuye fuera de npm) y `exceljs` (sin cambios desde 2024 y con muchas dependencias) |
| CSV | propio (`src/main/attachments/extract.ts`) | — | RFC 4180 con detección de separador (`,` `;` tab `\|`) y de codificación; no justificaba una dependencia |
| OCR | `tesseract.js` + `@tesseract.js-data/eng`·`spa` | 7.0 | OCR local; datos eng+spa (best_int, ~5 MB) incluidos en las dependencias y copiados a `userData/ocr` la primera vez: nunca se descargan |
| Imágenes | `@napi-rs/canvas` | 1.2 | Decodificar PNG/JPEG/WEBP/GIF/SVG, miniaturas, copia para visión y dibujo de páginas PDF (N-API, binarios precompilados, sin recompilar para Electron) |
| ZIP | `yauzl` | 3.4 | Lectura en streaming; los nombres se validan uno a uno (`getFileNameLowLevel`) para rechazar entradas peligrosas sin descartar el resto |
| Búsqueda | `@vscode/ripgrep` | 1.18 | Binario `rg` empaquetado: búsqueda en proyectos grandes en milisegundos |
| Instalador | `electron-builder` | 26.18 | NSIS por usuario, fusibles e integridad del ASAR integrados (`electron-builder.yml`); verificado en npm el 23-11-2026 |
| Updates | `electron-updater` | 6.8.11 | GitHub Releases; descarga verificada con sha512; sin firma en Windows |
| Tests | `vitest`, `@playwright/test` (modo Electron) | — | Unitarios + E2E de la app real |

**Fuentes**: Geist y Geist Mono (`@fontsource-variable/*`, empaquetadas; referencia de diseño).

**Descartado a propósito**: cliente `ollama` de npm (la API REST es pequeña; un cliente propio sobre `fetch` nos da `AbortController` por petición y control del streaming NDJSON), ORMs (SQL plano + migraciones versionadas basta), `sharp` (las miniaturas se hacen con `nativeImage` de Electron), `chokidar` (`fs.watch` recursivo es nativo en Windows y macOS).

---

## 3. Arquitectura de procesos

```
┌──────────────────────────── Renderer (React, sandbox) ────────────────────────────┐
│ Sidebar · Chat · Actividad · Editor (Monaco) · Terminal (xterm) · Ajustes          │
│                      window.zhaska  (API tipada expuesta por preload)              │
└───────────────────────────────▲───────────────────────────────┬───────────────────┘
                     eventos     │ contextBridge (sin Node)      │ invoke(canal, args)
┌────────────────────────────────┴─ Main process ──────────────▼───────────────────┐
│ IPC Router (zod + validación de sender) · Ventanas · Permission Broker            │
│ Database (SQLite) · Settings · Ollama Supervisor · PTY Host · Updater · Backups   │
└───────────────▲──────────────────────────────────────────────┬───────────────────┘
                │ MessagePort (eventos del agente, peticiones de aprobación)       │
┌───────────────┴──────────── Agent Host (utilityProcess) ─────▼───────────────────┐
│ AI Engine: AgentLoop · ContextBuilder · ToolRegistry · Providers (Ollama, …)       │
│ Workspace: PathGuard · ProjectIndex · ChangeTracker/Checkpoints · CommandRunner    │
└───────────────────────────────────────────────┬──────────────────────────────────┘
                                                 │ HTTP localhost:11434
                                           ┌─────▼─────┐
                                           │  Ollama   │  (proceso externo)
                                           └───────────┘
```

### Responsabilidades

| Proceso | Hace | No hace |
|---|---|---|
| **Renderer** | Pintar UI, estado de vista, Monaco, xterm | Acceder a disco, red o Node. Nunca habla con Ollama |
| **Preload** | Expone `window.zhaska` con métodos concretos y tipados | Exponer `ipcRenderer` genérico |
| **Main** | Ciclo de vida, ventanas, IPC, base de datos, ajustes, permisos (puente con la UI), supervisión de Ollama, PTY de terminales de usuario, actualizaciones | Ejecutar el bucle del agente ni trabajo pesado |
| **Agent Host** (`utilityProcess`) | Bucle del agente, proveedores de IA, herramientas, indexación, extracción | Mostrar diálogos (los pide a main) |

**Por qué un `utilityProcess` para el agente**: aislamiento de fallos (si el agente o un parser se cuelga, la UI sigue viva y se reinicia el host), y el hilo principal de Electron queda libre para IPC y ventanas. Es el patrón de VS Code (extension host / pty host) a escala reducida.

**Por qué la base de datos en main**: un único escritor; las consultas de UI son de <1 ms con WAL. El Agent Host no escribe en SQLite: emite eventos y main los persiste. Así no hay dos conexiones compitiendo.

---

## 4. Comunicación Electron ↔ React (IPC seguro)

### 4.1 Configuración de la ventana

```ts
new BrowserWindow({
  webPreferences: {
    preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
    webSecurity: true, spellcheck: false,
  },
  titleBarStyle: 'hidden', titleBarOverlay: { color: '#0A0C11', symbolColor: '#9AA1B2', height: 36 },
})
```

- Renderer servido por protocolo propio `app://` (no `file://`), con CSP estricta (`src/shared/csp.ts`), aplicada como `<meta>` y además como cabecera HTTP de `app://` (Fase 9):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`.
- `app.enableSandbox()` y, para **cualquier** webContents (`web-contents-created`): `will-attach-webview` cancelado, `setWindowOpenHandler` → `deny`, `will-navigate`/`will-redirect` cancelados salvo recargar. Los enlaces que escribe el modelo no son navegables.
- `session.setPermissionRequestHandler` deniega todo (cámara, micro, notificaciones web…).
- Lista de comprobación de Electron punto por punto y auditoría de los canales: [docs/SECURITY.md](docs/SECURITY.md).
- **Electron Fuses** (aplicados al empaquetar desde la Fase 10, `electron-builder.yml → electronFuses`; comprobados en el binario por `scripts/package-e2e.mjs`): `RunAsNode=off`, `EnableNodeOptionsEnvironmentVariable=off`, `EnableNodeCliInspectArguments=off`, `EnableEmbeddedAsarIntegrityValidation=on`, `OnlyLoadAppFromAsar=on`, `EnableCookieEncryption=on`, `GrantFileProtocolExtraPrivileges=off`.

### 4.2 Contrato tipado único

Todo canal se declara una vez en `src/shared/ipc/contract.ts`:

```ts
export const ipc = {
  'project.open':      { req: z.object({ path: z.string() }), res: ProjectSchema },
  'fs.readFile':       { req: z.object({ projectId: Id, rel: RelPath }), res: FileContentSchema },
  'agent.start':       { req: StartTaskSchema, res: z.object({ taskId: Id }) },
  'agent.cancel':      { req: z.object({ taskId: Id }), res: z.void() },
  'approval.respond':  { req: ApprovalResponseSchema, res: z.void() },
  'models.pull':       { req: z.object({ name: z.string() }), res: z.object({ jobId: Id }) },
  // …
} as const

export const events = {
  'agent.event':  AgentEventSchema,     // §6.6
  'models.pullProgress': PullProgressSchema,
  'ollama.status': OllamaStatusSchema,
  'terminal.data': TerminalDataSchema,
  'update.status': UpdateStatusSchema,
} as const
```

- **Preload** genera `window.zhaska.project.open(...)`, `window.zhaska.on('agent.event', cb)` a partir del contrato: el renderer nunca ve nombres de canal libres.
- **Main** valida `req` con zod antes del handler y comprueba `event.senderFrame.url` (solo `app://zhaska` o el servidor de desarrollo). Las respuestas también se validan en desarrollo.
- Cada llamada devuelve `IpcResult` = `{ ok: true, data } | { ok: false, error: { code, message } }` con códigos estables (`INVALID_INPUT`, `NOT_FOUND`, `FORBIDDEN`, `FORBIDDEN_PATH`, `CONFLICT`, `EXISTS`, `IO`, `INTERNAL`); el renderer los convierte en `ApiError` (`src/renderer/src/lib/api.ts`).
- Implementación: `src/shared/ipc/contract.ts` (esquemas), `src/shared/ipc/channels.ts` (lista blanca del preload, verificada por test), `src/main/ipc/router.ts` y `handlers.ts`.
- Rutas: el renderer envía **rutas relativas al proyecto** + `projectId`; main/agent resuelven y validan con `PathGuard`. Nunca rutas absolutas arbitrarias desde la UI: desde la Fase 9, abrir o crear un proyecto solo acepta carpetas devueltas por el selector nativo en esta sesión, arrastradas a la ventana (canal `paths.grantDropped`, exclusivo del preload: la ruta sale de `webUtils.getPathForFile`), ya conocidas o la carpeta de proyectos configurada. Las carpetas autorizadas, exportar e importar abren sus diálogos en main.
- Ajustes: `settings.set` solo acepta las claves de `src/shared/settings.ts`, cada una con su esquema (p. ej. `ollamaHost` solo en este equipo, `projectsDir` elegido con el selector).
- Datos de terminal: eventos `terminal.data` agrupados en lotes de 16 ms por sesión (suficiente para `npm install` o servidores de desarrollo). Si hiciera falta más caudal, el siguiente paso sería un `MessagePort` por sesión.

---

## 5. Almacenamiento local

### 5.1 Ubicaciones (separación instalación ↔ datos)

| Qué | Dónde (Windows) |
|---|---|
| Programa | `%LOCALAPPDATA%\Programs\ZHASKA\` (NSIS por usuario, sin admin) — se sustituye en cada update |
| Datos de usuario | `%APPDATA%\ZHASKA\` — **nunca** lo toca el instalador ni el updater. En desarrollo: `ZHASKA-dev` (no se mezclan). `ZHASKA_USER_DATA` permite aislarlos (pruebas) |
| ├ `data/zhaska.db` | SQLite principal (WAL) |
| ├ `data/index/<projectId>.db` | Índice por proyecto (FTS5), desechable y reconstruible |
| ├ `attachments/<aa>/<sha256>/` | `original.<ext>` + `extracted.txt` + `meta.json`; según el tipo `thumb.jpg`, `vision.jpg`, `sheets.json`, `entries.json`, `unzipped/` y `description-<modelo>.txt` |
| ├ `ocr/` | Datos de OCR eng+spa y caché de tesseract |
| ├ `checkpoints/<projectId>/blobs/<sha256>` | Instantáneas antes/después de cada cambio del agente (direccionadas por contenido; retención §10) |
| ├ `backups/` | Copias de `zhaska.db`: diarias (7), antes de migrar, manuales, antes de restaurar y antes de importar. Archivos SQLite autónomos (sin `-wal`) |
| ├ `import/<id>/` | Importación comprobada y preparada, a la espera de reiniciar (se borra al aplicarla o tras 1 h) |
| ├ `data/pending-restore.json` · `data/last-operation.json` | Restauración/importación programada y su resultado (aviso tras reiniciar) |
| └ `logs/` | Logs rotativos (sin contenido de archivos ni prompts por defecto) |

Los modelos los gestiona Ollama en su propio directorio (`%USERPROFILE%\.ollama\models`); la app no los duplica.

### 5.2 Esquema SQLite (v1)

```sql
projects(id, name, root_path UNIQUE, created_at, last_opened_at, settings_json)
conversations(id, project_id → projects, title, model, created_at, updated_at, archived)
messages(id, conversation_id, role CHECK(role IN ('user','assistant','tool','system')),
         content, tool_calls_json, tool_call_id, tokens_in, tokens_out, created_at)
attachments(id, sha256, file_name, ext, kind, size, status, error, meta_json, created_at)   -- migración 5
message_attachments(message_id, attachment_id, position)
agent_tasks(id, conversation_id, status, model, started_at, finished_at, summary, error)
activity_events(id, task_id, seq, type, step_id, phase, payload_json, ts)   -- log del panel
changesets(id, task_id, project_id, status CHECK(status IN ('pending','accepted','rejected','partial')), created_at)
file_changes(id, changeset_id, rel_path, kind CHECK(kind IN ('create','modify','delete','rename')),
             before_blob, after_blob, additions, deletions, decision)
checkpoints(id, project_id, kind CHECK(kind IN ('auto','manual','git')), label, git_ref, created_at)
permission_rules(id, project_id NULL, tool, pattern, decision CHECK(decision IN ('allow','ask','deny')), created_at)
models(name PRIMARY KEY, provider, capabilities_json, context_length, size_bytes, last_used_at)
settings(key PRIMARY KEY, value_json)
schema_migrations(version, applied_at)
```

- Archivos pesados **fuera** de SQLite; la BD guarda rutas, hashes y metadatos.
- Migraciones numeradas en `src/main/db/migrations.ts`, aplicadas en una transacción tras hacer backup.
- Backups con la API online de SQLite (`backup()` de `node:sqlite`), sin bloquear la app.
- Las carpetas autorizadas de cada proyecto se guardan en `projects.settings_json` (`authorizedDirs`).

### 5.3 Restaurar, exportar e importar (Fase 9)

- **Restaurar** (`src/main/db/restore.ts`): la copia se comprueba sobre un duplicado temporal (integridad de SQLite, que sea de ZHASKA y que su esquema no sea más nuevo que el de la app). Como la base de datos no se puede sustituir en uso, se programa (`pending-restore.json`) y la app se reinicia con un cierre ordenado. Al arrancar, **antes de abrir la base de datos**: copia la entrante, vuelca el WAL actual, guarda la copia «Antes de restaurar» y sustituye con un renombrado como último paso. Si algo falla, los datos no cambian. Nunca se reintenta en bucle.
- **Exportar** (`src/main/data/portable.ts`): `.zhaska` = ZIP con `manifest.json`, `zhaska.db` (instantánea con la API de backup) y, opcionalmente, `attachments/`. Escritor ZIP propio con `deflateRawSync` + `crc32` de Node (sin dependencias), escritura a `.part` y renombrado.
- **Importar**: archivo `.zhaska` o una copia `.db` suelta. Lista blanca de rutas (`manifest.json`, `zhaska.db`, `attachments/<aa>/<sha256>/…`), nombres validados con las reglas del ZIP seguro (`src/core/security/zipNames.ts`), sin ejecutables, enlaces ni cifrado, límites de entradas y tamaño, detección de bombas ZIP; se prepara en `import/<id>/`, se muestra un resumen y se aplica al reiniciar igual que una restauración (copia «Antes de importar»). Los adjuntos se añaden sin sobrescribir.
- Prueba real con tres arranques de la app: `npm run test:restore` (`scripts/restore-e2e.cjs`).

---

## 6. AI Engine (agente de programación)

### 6.1 Capas

```
AgentLoop ──usa──▶ ModelProvider (interfaz)  ◀── OllamaProvider | (futuro) OpenAICompatProvider | …
    │                    ▲
    │                    └── ToolCallProtocol: NativeTools | StructuredJSON   (adaptador por modelo)
    ├──▶ ContextBuilder (system prompt, proyecto, historial, presupuesto de tokens)
    ├──▶ ToolRegistry  ──▶ Tool { name, schema(zod), risk, execute(ctx) }
    ├──▶ PermissionGate ──▶ (pide a Main) ──▶ UI de aprobación
    ├──▶ ChangeTracker / Checkpoints
    └──▶ EventBus ──▶ Main (persistencia + UI)
```

### 6.2 Interfaz de proveedor

```ts
interface ModelProvider {
  id: string                                  // 'ollama', 'openai-compat', …
  listModels(): Promise<ModelInfo[]>
  getCapabilities(model: string): Promise<ModelCapabilities>
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>
}

interface ModelCapabilities {
  tools: boolean; vision: boolean; audio: boolean; thinking: boolean
  structuredOutput: boolean; contextLength: number; embedding: boolean
}
```

- Las capacidades de Ollama se leen de **`POST /api/show`** (campo `capabilities`: `completion`, `tools`, `vision`, `thinking`…) y `model_info.*.context_length`; no se codifican a mano. La UI oculta lo que el modelo no soporta (p. ej. el botón de imagen si no hay `vision` y no hay modelo de visión auxiliar).
- `ChatChunk` normalizado: `{ type: 'text' | 'thinking' | 'tool_call' | 'done', … , metrics? }`. El agente no sabe de NDJSON ni de plantillas de chat.

### 6.3 Protocolo de llamadas a herramientas (compatibilidad Gemma)

Gemma 4 aparece en Ollama con la etiqueta `tools` y *function calling* nativo. Aun así, la fiabilidad de un modelo de 4–12 B en bucles largos es el **mayor riesgo técnico** del producto. Por eso hay dos protocolos intercambiables:

1. **NativeTools** (por defecto si `capabilities.tools`): se envían `tools` en `/api/chat` y se leen `message.tool_calls`.
2. **StructuredJSON** (fallback o modelos sin `tools`): se usa `format: <JSON Schema>` (salida estructurada restringida por gramática en Ollama), con la forma
   `{"action":"tool","tool":"read_file","args":{…}}` | `{"action":"final","message":"…"}`.
   La gramática garantiza JSON parseable en cada turno.

Capas de robustez comunes a ambos:

- **Validación zod** de los argumentos. Si fallan, no se ejecuta nada: se devuelve al modelo un `tool_result` de error conciso con el esquema esperado (*self-repair*, máx. 2 reintentos por llamada).
- **Normalización**: nombres con alias (`readFile`→`read_file`), rutas con `\`→`/`, argumentos como string JSON → objeto.
- **Detección de bucles**: misma herramienta + mismos argumentos 3 veces → se interrumpe y se informa.
- **Límites**: `maxSteps` (por defecto 40), timeout por herramienta, tamaño máximo de resultado (truncado con aviso "…N líneas omitidas, usa read_file con offset").
- **Pocas herramientas, descripciones cortas**: ~14 herramientas con una línea de descripción y un ejemplo. Los modelos pequeños empeoran con catálogos grandes.
- **Edición por búsqueda/sustitución** (`old_string`→`new_string` exacto, único) en lugar de diffs unificados, que los modelos pequeños generan mal. Si `old_string` no aparece o es ambiguo, el error indica las líneas candidatas.
- **Thinking**: si el modelo lo soporta se activa con `think: true` en la API. El contenido de *thinking* **no se muestra ni se guarda** en el historial (Gemma recomienda no reinyectarlo); la UI solo muestra el estado "Razonando…" con su duración real.
- **Banco de pruebas de protocolo** (`/bench`): suite de tareas fijas que mide % de llamadas válidas, pasos hasta completar y tok/s por modelo y protocolo. Se ejecuta en el onboarding (versión corta) y decide el protocolo por defecto de cada modelo con datos, no con suposiciones.

### 6.4 Herramientas

| Herramienta | Riesgo | Notas |
|---|---|---|
| `get_project_structure` | lectura | Árbol con profundidad y filtros (`.gitignore`, `node_modules`, binarios) |
| `list_files` | lectura | Directorio concreto, paginado |
| `read_file` | lectura | Con `offset/limit` de líneas; numeradas |
| `search_code` | lectura | Búsqueda propia sin dependencias (texto o regex, glob, máx. 80 resultados, sin archivos protegidos). Fase 11: lectura en paralelo hasta 100 000 archivos u 8 s; con 50 000 archivos los recorre todos en ~2 s (antes se cortaba a los 5 000 y no encontraba lo que había después). Sin ripgrep: no ha hecho falta |
| `read_project_config` | lectura | Detecta y resume package.json, tsconfig, pyproject, requirements, Cargo.toml… |
| `read_attachment` | lectura | **Solo adjuntos** de la conversación, por nombre o id, con offset y archivos dentro de un ZIP. No hay herramienta de escritura de adjuntos (Fase 8). Solo se ofrece si hay adjuntos |
| `update_plan` | ninguno | El modelo declara/actualiza sus pasos → alimenta la sección *Planificación* del panel |
| `create_file` | escritura | Falla si existe (para cambiarlo: `edit_file` o `write_file`) |
| `edit_file` | escritura | Búsqueda/sustitución exacta; varias ediciones por llamada; las que no cambian nada se ignoran; `old_string` vacío en una edición sola = añadir al final (Fase 11) |
| `write_file` | escritura | **Fase 11.** Reescribe entero un archivo existente de hasta 400 líneas (los modelos intentaban reescribir bloques línea a línea con `edit_file`); conserva CRLF; mismo registro de cambios y diff |
| `delete_file` | destructivo | Siempre con checkpoint; aprobación según política |
| `execute_command` | ejecución | Clasificado por `CommandPolicy` (§9.3); salida en vivo a una pestaña "Agente" de la terminal |
| `install_dependencies` | ejecución | Detecta gestor (npm/pnpm/yarn/pip/uv) y ejecuta; siempre visible |
| `run_tests` | ejecución | Detecta el script de test/build y lo ejecuta; parsea resumen |
| `inspect_errors` | lectura/ejecución | Ejecuta el diagnóstico apropiado (tsc --noEmit, eslint, py_compile, salida de build) y devuelve errores estructurados `{file, line, message}` |

Cada herramienta es un módulo `{ name, description, schema, risk, phase, execute(ctx, args) }`. `ctx` da acceso **solo** a `workspace` (PathGuard), `attachments` (solo lectura), `commands`, `changes`, `emit` y `signal` (cancelación).

### 6.5 Bucle de ejecución

```
start(task):
  checkpoint.auto(project)                    # antes de cualquier escritura
  ctx = ContextBuilder.initial(task)          # system + resumen de proyecto + adjuntos + mensaje
  loop step = 1..maxSteps:
    if signal.aborted → emit(cancelled); break
    stream = provider.chat(ctx.messages, tools, protocol)
    for chunk in stream: emit(message.delta | thinking.state)
    calls = protocol.extractCalls(result)
    if calls.empty → final answer → break
    for call in calls:
      args = validate(call) | repair-feedback
      decision = PermissionGate.check(call)        # puede pausar esperando al usuario
      emit(step.started); res = tool.execute(); emit(step.completed | step.failed)
      ctx.append(tool_result(truncate(res)))
    if wroteFiles && autoVerify → inspect_errors automático y resultado al contexto
  ChangeTracker.finalize() → changeset 'pending' → tarjeta de diff en el chat
  emit(task.completed { summary, filesChanged, durationMs, tokens })
```

**Perfiles por modelo y robustez en tareas largas** (Fase 11, `src/shared/agent/modelProfiles.ts`):

- **Herramientas ofrecidas por tarea**: no se ofrecen las que el usuario bloqueó (escribir, ejecutar, instalar) ni `read_attachment` sin adjuntos. Menos herramientas = menos tokens de prefijo y menos confusión. El prompt solo nombra las ofrecidas.
- **Perfiles medidos, no supuestos**: se probó un prompt compacto (reglas cortas, ejemplos de `edit_file`, sin `update_plan`/`read_project_config`/`get_project_structure`) para modelos de ≤ 5B. Con Gemma 4 E4B en las 7 tareas de evaluación: **completo 6/7, compacto 4/7** (con el compacto se queda leyendo sin editar). Decisión: todos los modelos usan el prompt completo; a los de ≤ 5B solo se les limita la temperatura a 0,15. El compacto se conserva para volver a medir (`ZHASKA_EVAL_PROMPT=compact`). En los MoE cuenta el tamaño total.
- **Repeticiones**: la misma llamada con los mismos argumentos sin cambios entre medias recibe primero un aviso con la pista concreta (y la siguiente respuesta se genera con +0,5 de temperatura para salir del bucle); solo a la quinta se detiene la tarea. Cada cambio real en un archivo reinicia el contador: releer y volver a pasar las pruebas después de editar es lo normal.
- **Errores accionables**: si faltan argumentos, el error dice cuál («falta el argumento obligatorio «path»») y lista los argumentos de la herramienta. `edit_file` con `old_string` vacío (en una edición sola) añade al final del archivo; y si el ancla es mínima y repetida («}») y el texto nuevo es esa ancla más algo añadido, se inserta tras la última y se le dice dónde; lo mismo si el texto nuevo empieza por un salto de línea sin repetir el ancla («insertar después de»). Los `\n` escritos como texto al principio o al final del texto nuevo se convierten en saltos reales. (Gemma 4 añade pruebas así aunque se le indique lo contrario.) `write_file` reescribe archivos pequeños enteros (los modelos intentaban hacerlo línea a línea con `edit_file`).
- **Olvidos y repeticiones de `edit_file`**: sin `path`, se usa el último archivo leído con `read_file` (la edición solo se aplica si el fragmento está en él, se le avisa y queda en el diff); si el texto nuevo ya está en el archivo, la edición se da por aplicada en lugar de fallar.
- **Respuestas vacías o que solo anuncian**: una respuesta sin texto ni herramientas no es un final (se le pide que siga, hasta dos veces); si anuncia lo que «va a hacer» sin haber cambiado nada, se le recuerda una vez que lo haga.
- Prueba de larga duración: `tests/eval/long.eval.ts` (tres tareas encadenadas con historial, comprobadas con pruebas ocultas).

**Contexto y presupuesto de tokens** (crítico con 8 GB VRAM):

- `num_ctx` explícito en cada petición (el valor por defecto de Ollama cambia según versión y VRAM; no se depende de él). Perfil por defecto 32K, configurable.
- **Historial solo-añadir** con prefijo estable (system prompt + definiciones de herramientas idénticas entre turnos) para aprovechar la caché de KV de Ollama: en un bucle agéntico el coste dominante es *prefill*, y con prefijo estable solo se procesan los tokens nuevos.
- Nunca se carga el proyecto entero: el contexto inicial incluye árbol resumido (≤ 2K tokens), config detectada y archivos mencionados con `@`. El resto lo pide el modelo con herramientas.
- Compactación al 75 % del presupuesto: los resultados de herramientas antiguos se sustituyen por resúmenes de una línea ("leído src/App.tsx, 120 líneas"), y si no basta, el modelo resume el tramo antiguo.

### 6.6 Eventos del agente (fuente única del panel de actividad)

```ts
type AgentEvent =
  | { type: 'task.started'; taskId; model; ts }
  | { type: 'plan.updated'; steps: { id; title; status }[] }          // de update_plan
  | { type: 'step.started'; stepId; tool; phase; title; target? }      // target: ruta o comando
  | { type: 'step.output'; stepId; chunk }                             // stdout en vivo
  | { type: 'step.completed'; stepId; summary; durationMs; diff?: { additions; deletions } }
  | { type: 'step.failed'; stepId; error; recoverable }
  | { type: 'step.cancelled'; stepId }
  | { type: 'approval.requested'; requestId; tool; detail; risk }
  | { type: 'approval.resolved'; requestId; decision }
  | { type: 'model.state'; state: 'prompt' | 'thinking' | 'generating'; tokensPerSec? }
  | { type: 'message.delta'; text } | { type: 'message.completed'; messageId }
  | { type: 'task.completed' | 'task.failed' | 'task.cancelled'; summary?; error? }
```

- **La fase se deriva de la herramienta real** (no de una animación): lectura/estructura/búsqueda → *Análisis*; `update_plan` → *Planificación*; create/edit/delete/execute/install → *Ejecución*; run_tests/inspect_errors y el auto-verify → *Verificación*. Un error detectado y la edición que lo corrige aparecen como pasos reales en *Verificación/Corrección*.
- Estados por paso: `pending` (solo los del plan declarado), `running`, `completed`, `failed`, `cancelled`.
- Todo evento se persiste (`activity_events`) → el panel de una conversación antigua se reconstruye igual.
- El texto *thinking* nunca viaja en eventos.

---

## 7. Integración con Ollama

### 7.1 Supervisor (main)

| Función | Implementación |
|---|---|
| ¿Instalado? | `where ollama` + rutas conocidas (`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`) |
| ¿En ejecución? | `GET http://127.0.0.1:11434/api/version` (timeout 1,5 s), sondeo cada 5 s con backoff |
| Arrancar | Lanza `ollama serve` como proceso hijo (con `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0` si el usuario activa "Optimizar memoria") o la app de bandeja si existe |
| Instalar | Con consentimiento: descarga `OllamaSetup.exe` de ollama.com, verifica firma Authenticode, lo ejecuta y espera a que responda la API |
| Modelos | `GET /api/tags`, `POST /api/show`, `POST /api/pull` (stream de progreso), `DELETE /api/delete` |
| Métricas | `GET /api/ps` → `size` y `size_vram` (porcentaje real en GPU); por respuesta `eval_count/eval_duration` (tok/s), `prompt_eval_*` (prefill), `total_duration`; RAM de los procesos de Ollama con PowerShell `Get-Process` (sin dependencias); VRAM total con `nvidia-smi --query-gpu` si existe |

Ollama solo se contacta en `127.0.0.1`. Si el usuario configura un host remoto, la UI lo marca como "no local".

### 7.2 Selección de modelo para RTX 5060 8 GB

Ver análisis completo en [`docs/MODELS.md`](docs/MODELS.md). Resumen:

| Perfil | Modelo | Por qué |
|---|---|---|
| **Equilibrado (por defecto)** | `gemma4:12b-it-qat` (7,2 GB) | Mejor calidad que cabe *casi* entera en GPU; 256K de contexto nativo (usaremos 32K) |
| Rápido | `gemma4:e4b-it-qat` (6,1 GB) | 100 % GPU, latencia mínima; para preguntas, explicaciones y tareas pequeñas |
| Calidad (oculto con < 32 GB RAM) | `gemma4:26b-a4b-it-qat` (16 GB) | MoE con ~4B activos. **No se ofrece en el equipo de referencia (16 GB RAM)**: 16 GB de pesos + Windows + la app dejan el sistema sin memoria. Se muestra como "no recomendado para tu equipo" |

La elección final se confirma en Fase 4 con mediciones reales en tu equipo (banco de pruebas, §6.3).

---

## 8. Adjuntos

**Separación estricta**: los adjuntos viven en `%APPDATA%\ZHASKA\attachments`, se referencian por id y solo son accesibles con `read_attachment` (lectura). Las herramientas de escritura solo operan sobre el `workspace` del proyecto activo. Para llevar el contenido de un adjunto al proyecto hay que pedírselo al agente: lo crea con `create_file` y queda en el diff como cualquier otro cambio (un botón directo «Añadir al proyecto» queda para más adelante).

Implementación (Fase 8): `src/main/services/attachments.ts` (almacén, estados, contexto para el modelo), `src/main/attachments/extract.ts` (extractores) y `worker.ts` (`out/main/attachments.js`, un **utilityProcess** desde la Fase 10: PDF, OCR y ZIP no bloquean la interfaz, un archivo malicioso que lo tumbe no arrastra al proceso principal y puede leer el ASAR de la app instalada; si se cae, el trabajo se reintenta una vez con un proceso nuevo). El OCR de tesseract corre en su propio `worker_thread`, que no lee el ASAR: se lanza desde `app.asar.unpacked`. pdfjs se carga en modo Node aunque esté en un utilityProcess.

```
renderer: archivo elegido, arrastrado o pegado → bytes por IPC (nunca rutas) → attachments.upload
main:     validar tamaño y extensión → sha256 (dedupe: mismo contenido = misma extracción) → original.<ext>
worker:   magic bytes → extraer: pdf (pdfjs; páginas sin texto → dibujar + OCR) | docx (mammoth)
                  | xlsx (read-excel-file → CSV por hoja) | csv/tsv (parser propio) | texto/código (UTF-8/16, Windows-1252)
                  | imagen (miniatura, copia ≤ 1568 px para visión, OCR) | zip (§9.4)
       → extracted.txt + meta.json → evento attachments.updated: 'processing' (con progreso) → 'ready' | 'error' (motivo)
enviar:   main valida que todos estén listos → el mensaje guarda la lista y la relación message_attachments
```

- Límites: 50 MB por archivo, 20 por mensaje, 200 MB y 10 000 entradas por ZIP, OCR de hasta 30 páginas escaneadas. Formatos binarios no analizables (.doc, .xls, .pptx, .rar, ejecutables…) se rechazan con un motivo; cualquier otro archivo se admite solo si su contenido es texto.
- Contexto: el texto de los adjuntos del mensaje va en el mensaje del usuario hasta ~35 % del contexto (45 % en «Solo chat»); si no cabe, se indica cuánto falta y el agente sigue con `read_attachment(name, offset)`. En un ZIP, `read_attachment(name, path)` lee un archivo de dentro y nunca sale de `unzipped/`. El agente puede releer cualquier adjunto de la conversación.
- **Imágenes**: si el modelo activo tiene `vision` (Gemma 4 lo tiene), la imagen va en el mensaje (`images`). Si no, un **modelo de visión auxiliar** local (Configuración → Modelos: automático, uno concreto o ninguno) la describe y la descripción se pasa marcada como tal (se guarda para no repetirla). Si no hay ninguno, el modelo recibe un aviso explícito y solo el texto del OCR: nunca se simula el análisis.
- Panel de actividad: el paso real «Adjuntos en el contexto» indica qué adjuntos e imágenes recibió el modelo; las lecturas posteriores aparecen como «Adjuntos leídos».

---

## 9. Seguridad

### 9.1 PathGuard

- Toda ruta del agente se resuelve con `path.resolve(root, rel)` → `fs.realpath` → comprobación de prefijo **case-insensitive en Windows** contra la raíz del proyecto y los directorios autorizados.
- Rechaza: rutas absolutas no autorizadas, `..` que escapan, symlinks/junctions que apuntan fuera, rutas UNC/dispositivo (`\\?\`, `\\.\`, `CON`, `NUL`…), flujos ADS (`file.txt:stream`).
- **Archivos protegidos** (editables en Ajustes → Agente y permisos desde la Fase 9; `src/shared/protectedFiles.ts`): por defecto `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.git/**`. Leerlos o modificarlos, con herramientas o con comandos, pide confirmación siempre; su contenido no entra en `search_code`.
- **Carpetas sensibles** (`src/core/security/sensitivePaths.ts`): nunca pueden ser un proyecto ni una carpeta autorizada la raíz de un disco, la carpeta personal completa (ni las que la contienen), carpetas del sistema (`C:\Windows`, `Program Files`, `ProgramData`, `/System`, `/usr`, `/etc`…), de credenciales (`~/.ssh`, `~/.aws`…), `AppData`/`~/Library` ni los datos de ZHASKA. Se permiten los temporales e iCloud Drive.

### 9.2 Permission Broker

Niveles de autonomía (referencia de diseño, Fase 3): **Preguntar siempre** · **Equilibrado** (por defecto: lee libremente, pide permiso para editar o ejecutar) · **Autónomo** (edita y ejecuta comandos permitidos sin preguntar). Cada nivel fija una política por acción (`read`, `write`, `execute`, `install`, `internet` → permitir / preguntar / bloquear) que el usuario puede ajustar; internet está bloqueado por defecto. La tabla siguiente es el comportamiento base; las acciones peligrosas preguntan siempre.

| Acción | Solo lectura | Preguntar | Automático |
|---|---|---|---|
| Leer dentro del proyecto | ✓ | ✓ | ✓ |
| Crear/editar dentro del proyecto | ✗ | preguntar | ✓ (con checkpoint) |
| Eliminar archivo | ✗ | preguntar | preguntar |
| Comando "seguro" (§9.3) | ✗ | ✓ | ✓ |
| Comando normal | ✗ | preguntar | ✓ |
| Comando peligroso | ✗ | preguntar con aviso rojo | preguntar con aviso rojo |
| Fuera del proyecto / elevado / sistema | ✗ | preguntar con aviso rojo | preguntar con aviso rojo |

La aprobación muestra exactamente lo que se hará (comando completo, directorio, archivos afectados) y ofrece *Permitir una vez* / *Permitir siempre en este proyecto* (crea `permission_rules`) / *Denegar*. Las reglas son visibles y revocables en Ajustes → Seguridad.

### 9.3 CommandPolicy

Clasificador sobre el comando *tokenizado* (no regex sobre texto libre) para PowerShell, cmd y shells POSIX. Revisado en la Fase 9: analiza por subcomandos (también saltos de línea, subshells y bloques `{ }`), quita los prefijos que esconden el programa (`VAR=1`, `env`, `sudo`, `xargs`, `npx`, `/bin/rm`, `\rm`), expande los scripts de `package.json` para juzgar lo que ejecutan de verdad, y marca los borrados (que **siempre** preguntan) y los archivos protegidos. Los huecos encontrados y sus pruebas están en [docs/SECURITY.md §4.2](docs/SECURITY.md).

- **Seguro** (lista blanca): `git status|diff|log`, `node -v`, `npm run <script existente>`, `npm test`, `tsc --noEmit`, `python -m pytest`, `ls/dir`…
- **Peligroso** (siempre aviso): borrado recursivo (`rm -rf`, `Remove-Item -Recurse`, `rd /s`, `del /s`), `format`, `diskpart`, `reg`, `bcdedit`, `shutdown`, `takeown`, `icacls`, `Set-ExecutionPolicy`, `runas`/`Start-Process -Verb RunAs`, instaladores de sistema (`winget`, `choco`, `msiexec`), `curl|iwr … | iex/sh`, redirecciones a rutas fuera del proyecto, `git push --force`, `git reset --hard`, `git clean -fdx`.
- Se ejecuta con `cwd` = raíz del proyecto, entorno filtrado (sin variables con secretos conocidos), timeout y límite de salida. Los procesos largos (servidores de desarrollo) se lanzan como *background* con id y se pueden detener desde el panel.
- **Limitación declarada**: un clasificador no es un sandbox. La defensa real es la aprobación del usuario + checkpoints. Un sandbox real (AppContainer / Windows Sandbox) se evaluará tras la v1.

### 9.4 ZIP seguro

Con `yauzl` en streaming, por entrada: rechazar rutas absolutas, `..`, letras de unidad, `:` (flujos alternativos), caracteres de control, nombres reservados de Windows y terminados en punto o espacio, enlaces simbólicos y entradas cifradas; límites de nº de entradas (10 000, si se supera no se extrae nada), tamaño total (200 MB) y ratio de compresión (> 100:1 en entradas de más de 1 MB = posible bomba ZIP, no se extrae); `yauzl` comprueba además que el tamaño real coincide con el declarado. Los ejecutables no se extraen, los ZIP anidados no se expanden y nada extraído se ejecuta jamás. Cada ruta final se vuelve a comprobar (`safeJoin`) y se escribe con `wx`. Se extrae en `attachments/<aa>/<sha256>/unzipped/` y la vista previa muestra lo extraído y lo rechazado con su motivo.

### 9.5 Lecturas fuera del proyecto (Fase 9)

`src/core/security/outsideReads.ts`. Las herramientas de archivos solo modifican el proyecto. Leer fuera de él: sin preguntar en las carpetas autorizadas de ese proyecto (las elige el usuario en un selector nativo); cualquier otra ruta pide aprobación y se concede solo esa ruta durante esa tarea. Nunca se leen los datos de ZHASKA, las carpetas de credenciales, rutas UNC ni flujos ADS, ni aprobándolo. Los enlaces simbólicos que salen de una carpeta autorizada necesitan aprobación. El prompt del agente lista las carpetas autorizadas.

### 9.6 Privacidad

- Ninguna telemetría. Únicas conexiones salientes: comprobación de updates (GitHub, desactivable y nunca antes de terminar el asistente inicial), descargas de Ollama/modelos y de actualizaciones iniciadas por el usuario y proveedores externos **solo** si el usuario los añade explícitamente (con aviso de que el contenido sale del equipo).
- Claves de API futuras cifradas con `safeStorage` (DPAPI en Windows).
- Logs sin contenido de archivos ni prompts salvo "modo diagnóstico" activado por el usuario.

---

## 10. Cambios, diff y checkpoints

- **ChangeTracker**: antes de cada escritura del agente guarda el contenido previo como blob (sha256) y registra un `file_change`. Al terminar la tarea se agrupan en un `changeset` *pending*.
- **Vista diff** (Monaco DiffEditor): por archivo y por hunk; *Aceptar*, *Rechazar* (restaura el blob previo), *Aceptar todo*. Los cambios ya están en disco (para que build/tests del agente funcionen); "rechazar" es una restauración precisa y verificada por hash. Si el usuario editó el archivo después, se avisa del conflicto antes de restaurar.
- **Checkpoints**: automático antes de cada tarea con escrituras; manual desde la UI. Si el proyecto es Git, el checkpoint registra además `HEAD` y, opcionalmente, crea un commit en una ref privada (`refs/zhaska/checkpoints/<id>`) sin tocar la rama del usuario. Si no hay Git, se ofrece `git init` o se usan solo blobs.
- **Retención** (Fase 9, `src/main/services/checkpoints.ts`): se conservan siempre las instantáneas de cambios pendientes de revisar y las de cambios de los últimos N días (30 por defecto; Ajustes → Privacidad y datos, con espacio usado y «Liberar espacio ahora»); las de menos de una hora tampoco se tocan. La limpieza corre al minuto de arrancar y cada 24 h. Si se pide el diff de un cambio cuya instantánea ya se borró, se explica el motivo.

---

## 11. Instalación, primera ejecución y actualizaciones

### 11.1 Onboarding (cada paso se verifica antes de marcarse ✓)

Implementado en la Fase 10 (`src/renderer/src/features/onboarding/Onboarding.tsx`; guía de prueba en [docs/WINDOWS.md](docs/WINDOWS.md)):

1. Requisitos: Windows 10 22H2 (compilación 19045)+/11 x64, RAM total, GPU y VRAM (`nvidia-smi`), espacio libre (`system.requirements`, `system.hardware`).
2. Ollama instalado → si no, ofrecer instalación (§7.1).
3. Ollama responde en la API → si no, arrancarlo.
4. Modelos instalados → recomendar perfil según hardware detectado.
5. Descargar el modelo elegido con progreso y tamaño.
6. Prueba de funcionamiento: respuesta corta (`models.test`) + una llamada a herramienta real (`models.toolTest`: `list_files` sobre un proyecto de ejemplo en una carpeta temporal, ejecutada de verdad con PathGuard, y respuesta con el resultado) + medición de tok/s.
7. Dependencias de desarrollo (Node, Python, Git): solo se **detectan e informan** (`system.devTools`; en Windows se descarta el alias de Python de la Microsoft Store); se piden cuando una tarea las necesita.
8. Primer proyecto: abrir una carpeta, crear uno nuevo o **probar el agente con un proyecto de ejemplo** (`mi-primer-proyecto` con una primera tarea ya escrita en el chat). Aquí se muestra la opción de buscar actualizaciones: la app no consulta el canal hasta terminar el asistente.

### 11.2 Instalador

`electron-builder.yml` (Fase 10):
- **NSIS por usuario** (`perMachine: false`, `allowElevation: false`: nunca pide administrador) en `%LOCALAPPDATA%\Programs\ZHASKA`, con elección de carpeta, accesos directos, desinstalador, en español, con el icono y las imágenes laterales de `build/` (`npm run icons` los genera desde el logotipo). `deleteAppDataOnUninstall: false`: desinstalar nunca borra `%APPDATA%\ZHASKA`.
- **ASAR** con integridad (hash en el binario) y **fusibles**. Fuera del ASAR (`asarUnpack`): `node-pty`, `@napi-rs/canvas` y el OCR (tesseract.js, su núcleo wasm y lo que requiere su hilo). `npmRebuild: false`: node-pty y canvas traen binarios N-API precompilados para Windows x64 y macOS. `scripts/after-pack.cjs` quita los binarios de otras plataformas y falla si falta el de destino.
- Solo se empaquetan las dependencias de ejecución de main (la interfaz va compilada por Vite): React, Monaco, xterm… son dependencias de desarrollo. Sin modelos dentro. App de Windows: ~440 MB sin comprimir (≈300 MB son Electron/Chromium).
- **Desde macOS**: `npm run dist:win` (descarga con `npm pack` el binario de canvas para Windows, `scripts/ensure-win-deps.cjs`). El generador NSIS de electron-builder para macOS es x86-64: en Apple Silicon necesita Rosetta 2 (instalada en el Mac de desarrollo). Sin repositorio de GitHub, `scripts/dist.cjs` empaqueta sin canal de actualizaciones (electron-builder fallaría al escribir `latest.yml`). Instalador resultante: ~160 MB.
- **CI**: `.github/workflows/release.yml` (etiqueta `vX.Y.Z` → pruebas en `windows-latest`, app empaquetada probada y borrador de versión en GitHub Releases).

**Pruebas de la app empaquetada** (`scripts/package-e2e.mjs`): como los fusibles impiden inyectar código, la prueba arranca el ejecutable real con `--remote-debugging-port` y lo maneja desde fuera: fusibles e integridad en el binario, interfaz sin Node, adjuntos (OCR, PDF, PDF escaneado, Word, Excel), terminal, el agente con Gemma 4 y copias. `scripts/update-e2e.mjs` compila 0.1.0 y 0.1.1 con un canal local y prueba buscar, descargar (sha512) y arrancar la nueva versión sobre los mismos datos.

### 11.3 Actualizaciones

`src/main/services/updates.ts` (Fase 10), electron-updater con proveedor GitHub Releases:
- Comprobación al arrancar (a los 15 s) y cada 6 h, **solo si** el usuario la tiene activada y ya terminó el asistente; envía únicamente la versión instalada. Aviso no intrusivo (barra de estado y Acerca de, con las novedades).
- `autoDownload` y `autoInstallOnAppQuit` desactivados: **descargar** (con progreso y verificación sha512) y **«Reiniciar e instalar»** son acciones del usuario; no con tareas en curso. Antes de instalar: copia «Antes de actualizar» de la BD. En Windows el instalador se aplica en silencio, por usuario, y la app se vuelve a abrir.
- Las migraciones se aplican al primer arranque de la nueva versión (con su copia «antes de migrar»), que avisa «ZHASKA se actualizó a la versión X» (`lastRunVersion`).
- Sin canal configurado (aún no hay repositorio: `app-update.yml` sin `provider`), la app lo dice tal cual y no busca nada.
- Las versiones se publican como **borrador**: llegan a los usuarios cuando se publican a mano tras probarlas.
- **Firma de código**: sin certificado (decisión del 22-11-2026). Windows SmartScreen avisa al instalar; electron-updater no exige firma en Windows (sin `publisherName`). macOS sí la exige para instalar (Squirrel.Mac), pero el producto es para Windows.

---

## 12. Estructura de carpetas

Estado real tras la Fase 10:

```
zhaska/
├─ electron.vite.config.ts · vite.shared.ts (CSP) · vite.web.config.ts · vitest.config.mts · tsconfig*.json
├─ scripts/smoke.cjs              # prueba de humo de la app compilada (npm run smoke)
├─ scripts/restore-e2e.cjs · restore-app.cjs   # restaurar/importar con tres arranques reales (npm run test:restore)
├─ scripts/package-e2e.mjs · update-e2e.mjs     # app empaquetada y actualización 0.1.0 → 0.1.1 (npm run test:package / test:update)
├─ scripts/make-icons.cjs · ensure-win-deps.cjs · after-pack.cjs · serve-updates.ps1   # marca, empaquetado, canal local
├─ electron-builder.yml · build/ (icon.png, barras laterales del instalador)
├─ docs/WINDOWS.md                # cómo probar instalación, asistente y actualización en el PC
├─ tests/unit/                    # PathGuard, SQLite, archivos, contrato IPC, agente, adjuntos, seguridad, datos
├─ docs/SECURITY.md               # amenazas, checklist de Electron, auditoría del IPC
├─ .github/workflows/ci.yml · release.yml   # CI (Windows y macOS) y publicación del instalador al etiquetar
├─ src/
│  ├─ shared/                     # sin Node ni DOM: importable por todos
│  │  ├─ ipc/contract.ts · ipc/channels.ts · bridge.ts · settings.ts (lista blanca) · protectedFiles.ts · csp.ts
│  │  ├─ agent/events.ts          # AgentEvent + fase por herramienta
│  │  └─ models/catalog.ts        # variantes de Gemma 4 y estimación de encaje
│  ├─ core/                      # Node, sin Electron: compartido por main y el Agent Host
│  │  ├─ errors.ts · security/ (pathGuard, commandPolicy, sensitivePaths, outsideReads, zipNames) · workspace/fileService.ts · commands/runner.ts
│  ├─ agent/                     # Agent Host (utilityProcess)
│  │  ├─ index.ts · bench.ts · providers/ (provider, ollama) · engine/ (loop, protocols)
│  │  ├─ tools/registry.ts        # las 14 herramientas
│  │  └─ workspace/ (changes, edit, explore)
│  ├─ main/
│  │  ├─ index.ts                 # arranque, instancia única, userData, migraciones, ventana
│  │  ├─ protocol.ts              # app://zhaska
│  │  ├─ errors.ts                # AppError con códigos
│  │  ├─ ipc/router.ts · ipc/handlers.ts
│  │  ├─ db/database.ts · migrations.ts · repos.ts · backups.ts · restore.ts
│  │  ├─ data/portable.ts         # exportar/importar .zhaska
│  │  ├─ agentHost.ts             # puente con el utilityProcess
│  │  ├─ attachments/ extract.ts (extractores) · worker.ts (utilityProcess → out/main/attachments.js)
│  │  └─ services/ projects (incl. plantillas y clonado) · watcher · hardware (incl. requisitos y herramientas) · ollama · models · chat · agent · terminals (node-pty) · attachments · checkpoints · updates
│  ├─ preload/index.ts            # window.zhaska (lista blanca de canales)
│  └─ renderer/src/
│     ├─ main.tsx · App.tsx · styles/index.css (tokens @theme)
│     ├─ lib/ (api, platform, format, phases) · layout/ (Shell, Workbench, TitleBar, StatusBar, atajos)
│     ├─ components/ui/ (Button, primitives, overlays, confirm, Tooltip) · components/Logo
│     ├─ features/ sidebar · chat · activity · explorer · editor · terminal · projects · settings · models · onboarding · welcome · palette · attachments
│     ├─ stores/ workspace · chat · projects · settings · layout · activity · ui · terminals · attachments
│     └─ demo/                    # ⚠️ datos simulados (proyecto de demostración)
└─ docs/ (MODELS.md, DESIGN.md, design/referencia-forja.pdf, design/mockup.html)
```

Regla de dependencias: `renderer` → `shared`; `main` → `shared`, `core`; `agent` → `shared`, `core`. `renderer` nunca importa de `main` ni de `agent`.

## 13. Riesgos técnicos

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| 1 | Fiabilidad del tool calling de Gemma 12B en tareas largas | Alto | Doble protocolo, validación + auto-reparación, edición por sustitución, banco de pruebas, límites y detección de bucles |
| 2 | 8 GB VRAM: contexto vs velocidad; el 12B no cabe al 100 % | Alto | `num_ctx` 32K, caché KV q8_0 + flash attention, perfiles, métricas reales de `size_vram` en la UI |
| 3 | Prefill lento en bucles agénticos | Medio | Prefijo estable + historial solo-añadir (caché KV), compactación, resultados truncados |
| 4 | Módulo nativo `node-pty` (Fase 7) con Electron 45 y Windows | Medio | SQLite ya no es nativo (`node:sqlite`); `@electron/rebuild` y CI en `windows-latest` con prueba de humo |
| 5 | Comandos destructivos | Alto | CommandPolicy revisada (Fase 9) + aprobación + checkpoints; los borrados por comando preguntan siempre; sin promesas de sandbox |
| 6 | SmartScreen sin firma de código | Medio | Decisión de compra de certificado (ROADMAP) |
| 7 | Particularidades Windows (rutas, CRLF, mayúsculas, rutas largas, antivirus) | Medio | PathGuard específico, preservar EOL al editar, pruebas en Windows |
| 8 | Ecosistema muy reciente (TS 7, Vite 8, Electron 45) | Bajo | Versiones fijadas con lockfile; fallback documentado |
| 9 | Proyectos grandes | Medio | ripgrep, índice en worker, árbol virtualizado, `fs.watch` con debounce, exclusiones por `.gitignore` |
| 10 | Configuración del servidor Ollama fuera de nuestro control (si lo arrancó el usuario) | Bajo | Detectar y avisar; `num_ctx` por petición siempre explícito |

## 14. Rendimiento (Fase 11)

Medido sobre la app **empaquetada** con `npm run test:perf` (`scripts/perf-e2e.mjs`, que la arranca y controla desde fuera) y en la app con **Configuración → Acerca de → Rendimiento** (`app.metrics`: hitos del arranque y memoria de cada proceso).

| Qué | Objetivo | Resultado en el Mac M4 (23-11-2026) | Cómo |
|---|---|---|---|
| Arranque hasta la interfaz usable | < 2 s | 0,34 s (mediana de 3; el primero tras compilar, 1,7 s) | Datos antes de la ventana (SQLite local, sin esperas de red); Monaco (editor y diff) se carga bajo demanda; el Agent Host ya no se arranca al inicio |
| Memoria en reposo (sin Ollama) | — | 487 MB en 4 procesos | El Agent Host (~90 MB) se arranca con la primera petición; el proceso principal usa 13 MB de montón JS: el resto es la base de Chromium |
| Proyecto de 50 000 archivos | navegable | abrir 0,06 s · desplegar una carpeta de 2 000 archivos 178 ms · buscar por nombre 98 ms · CPU en reposo 0 % · 557 MB | Explorador perezoso por carpetas y por tandas de 500; índice de nombres en main (`FileIndex`, se actualiza con el vigilante, sin seguir enlaces ni entrar en dependencias); vigilante nativo recursivo con agrupación de 150 ms |

- `fs.findFiles` (`src/core/workspace/fileIndex.ts`): búsqueda difusa (letras en orden, más peso al nombre, a las letras seguidas y a los inicios de palabra) sobre hasta 300 000 rutas; la paleta (Ctrl K) busca en todo el proyecto, no solo en lo abierto.
- En el PC de destino los tiempos serán algo mayores (CPU y disco distintos): `npm run test:perf` sobre `dist/win-unpacked` lo mide allí.

## 15. Asistente de empresa (Fase 12)

Chat aparte del de programación para trabajo de oficina, con bases de conocimiento locales. Separado por diseño: sin proyecto, **sin herramientas** (no lee, escribe ni ejecuta nada por su cuenta) y con sus propias tablas.

| Pieza | Archivo | Qué hace |
|---|---|---|
| Esquema | `src/main/db/migrations.ts` (v6) | `kb_collections`, `kb_folders`, `kb_documents`, `kb_chunks` (texto + vector Float32 normalizado), `kb_chunks_fts` (FTS5, BM25, sin tildes), `assistant_conversations`, `assistant_messages` |
| Índice | `src/main/assistant/knowledge.ts` | Recorre las carpetas elegidas (sin enlaces, ocultos ni dependencias; ≤ 5 000 archivos por carpeta, ≤ 50 MB cada uno), extrae el texto con el extractor de adjuntos (`AttachmentService.extractText`, mismo proceso aislado), trocea (`text.ts`: por páginas y hojas, ~1 200 caracteres con solape) y calcula vectores con EmbeddingGemma en Ollama (`/api/embed`, prefijos de consulta/documento). Solo reindexa lo que cambió (tamaño, fecha o modelo); vigila las carpetas (`fs.watch` recursivo, 3 s de calma) |
| Búsqueda | `knowledge.search` | Palabras (FTS5) + significado (producto escalar en memoria, caché por base, similitud mínima 0,35) fusionadas con Reciprocal Rank Fusion; 8 fragmentos |
| Chat | `src/main/assistant/service.ts` | Busca, añade los fragmentos numerados a la pregunta, genera con el Agent Host (`chat.start`, temperatura ≤ 0,3) y guarda la respuesta con sus fuentes (marcadas si se citan). `checkAnswer` avisa si cita números que no existen o da cifras sin citar |
| Reglas del modelo | `src/shared/assistant.ts` | Citar `[n]`, decir «No aparece en tus documentos» si no está, no inventar, copiar importes tal cual |
| Interfaz | `src/renderer/src/features/assistant/AssistantView.tsx`, `stores/assistant.ts` | Vista «Asistente de oficina»: conversaciones (normales y privadas), bases de conocimiento (carpetas, documentos, errores, progreso), fuentes desplegables con «Abrir», plantillas y adjuntos |

**Privacidad**: conversaciones **privadas** solo en memoria; una base **confidencial** obliga a conversación privada (y una conversación guardada no puede conectarla). Las carpetas pasan por la misma comprobación de carpetas sensibles que los proyectos (`workspaceRootProblem`). «Abrir» un documento solo acepta ids de documentos indexados. Las pruebas comprueban con `diagnostics_channel` que toda la red va a `127.0.0.1`.
