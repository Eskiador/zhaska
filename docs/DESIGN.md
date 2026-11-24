# Sistema de diseño — ZHASKA

> **Referencia visual oficial desde el 22-11-2026: [`docs/design/referencia-forja.pdf`](design/referencia-forja.pdf)** (diseño "Forja" creado por el usuario con Claude Design).
> El nombre del producto sigue siendo **ZHASKA**: donde el diseño dice "Forja" (marca, `FORJA.md`, textos), la app dice "ZHASKA" (`ZHASKA.md`).
> Las secciones 1–6 más abajo describen la propuesta inicial de la Fase 2; **cuando contradigan la referencia, manda la referencia**.

## 0. Diseño de referencia (Forja)

### Tokens (página "Fundamentos")

| Grupo | Tokens |
|---|---|
| Superficies | `bg-app #09090B` · `bg-terminal #08080A` · `bg-explorer #0A0A0D` · `bg-activity #0B0B0E` · `bg-sidebar #0C0C0F` · `bg-chat #0F0F12` · `bg-raised #141418` · `bg-active #1A1A21` — cada panel tiene su tono; el chat es el más claro |
| Texto y bordes | `text-1 #EDEDF2` · `text-2 #A3A3AE` · `text-3 #85858F` · `text-disabled #55555F` · `border-subtle #1C1C22` · `border #26262E` · `border-strong #34343E` |
| Acento y estados | `accent #8E87FF` · `accent-solid #5B52EE` · `accent-hover #665EF4` · `accent-soft #1E1D33` · `success #4ADE9A` · `warning #F2C063` · `error #FF6B70` · `info #6CB6FF` · `git-modified #E9B95E` — el violeta solo marca lo vivo: foco, selección y trabajo del agente |
| Sintaxis | keyword `#B7A8FF` · function `#7DB8FF` · string `#93D9A9` · number `#F5B97A` · type `#6ED7D3` · plain `#DADAE2` · punct `#8B8B96` · comment `#7D7D8A` |
| Tipografía | Geist / Geist Mono. display 30/36·600 · title 18/24·600 · heading 13/18·500 · body 14/24 · ui 13/18 · small 12/16 · label 11/14·500 +6 % mayúsculas · code 12,5/20 · terminal 12/19 |
| Espaciado | base 4: 2 · 4 · 6 · 8 · 10 · 12 · 16 · 24 · 32 · 56 |
| Radios | 4 kbd/tags · 6 botón de icono · 7 botón/fila · 8 input · 10 tarjeta · 12 popover · 14 diálogo · 999 pill |
| Movimiento | agente trabajando pulse 1,8 s · respuesta shimmer 2,6 s · cargando spin 0,9 s · progreso sweep 1,4 s · cursor blink 1,1 s · hover 120 ms · paneles 200 ms ease-out |
| Iconos | lineales 24 px, trazo 1,6 (Lucide) |

### Distribución de la ventana (1728 × 1080)
Barra de título 40 · **Sidebar** 248 (200–340) · **Chat** flexible, mín. 420, contenido máx. 720 · **Actividad** 296 (248–420) · **Explorador** 188 (150–300) · **Editor** (pestañas 38, migas 28, línea 20) · **Terminal** bajo explorador + editor.
Métricas: cabecera de panel 44 · fila de lista 30 · fila de árbol 24 (6 + 12/nivel) · botón 28/32/36 · botón de icono 28/24 · input 32/36 · composer ≥ 96.

### Pantallas y fase en la que se aplican

| Pantalla de la referencia | Fase |
|---|---|
| Fundamentos (tokens, tipografía, radios, movimiento) | **3** |
| Ventana principal: barra de título, sidebar (conversaciones por fecha, proyectos recientes con inicial, tarjeta de modelo en memoria), explorador como panel propio | **3** (estructura y sidebar) · 4 (tarjeta de modelo) |
| Nuevo proyecto (plantilla / abrir carpeta / clonar) | **3** (Vacío y Abrir carpeta) · **7 (hecho: React + Vite, Next.js, clonar)** · Electron/API Node/Python más adelante |
| Configuración (navegación General/Apariencia/Editor/Atajos · Modelos/Ollama/Agente y permisos/Contexto · Privacidad/Acerca de) | **3** (estructura y persistencia) · 4–5 (Ollama, Agente y permisos) |
| Ollama (servidor, memoria, modelos instalados) · Descargar Gemma 4 · Selector de modelo del composer · indicador de conexión | 4 |
| Asistente de primera ejecución (4 pasos) | 4 · **10 (hecho)**: requisitos, herramientas, prueba de herramientas, actualizaciones y proyecto de ejemplo |
| Panel de actividad (tarea actual, estadísticas, pasos, pausar agente) · estados de pasos | **6 (hecho)** |
| Editor con propuestas en línea ("Cambio 1 de 3 · Aceptar/Rechazar"), pestañas Código/Cambios, terminal con pestañas Terminal/Problemas/Agente | **7 (hecho)**; «Salida/Pruebas» de la referencia se cubren con Agente y Problemas |
| Contexto adjunto y visor de adjuntos | **8 (hecho)** |
| Agente y permisos: archivos protegidos editables y carpetas autorizadas · Privacidad y datos: copias con «Restaurar…», exportar/importar, instantáneas | **9 (hecho)**; mismas filas y grupos que el resto de la Configuración |


> Fase 1: dirección visual. Maqueta estática navegable: [`docs/design/mockup.html`](design/mockup.html) (datos **simulados**, marcados como tales).

## 1. Principios

1. **El trabajo del agente es el protagonista.** El color de acento aparece donde hay actividad real; el resto de la interfaz es casi monocroma.
2. **Densidad de herramienta profesional, legibilidad de producto de consumo.** Base de 13 px, contraste AA mínimo, jerarquía por peso y color, no por tamaño.
3. **Cada píxel con estado significa algo.** Ningún spinner sin una operación detrás; ningún botón sin acción.
4. **Calma.** Bordes de 1 px, sombras casi invisibles, animaciones de 120–200 ms. Nada de degradados decorativos.

Identidad: *ZHASKA* — azul cobalto para la acción del usuario y la selección; **violeta** reservado exclusivamente para lo que hace el agente. Así el usuario distingue de un vistazo "lo que hice yo" de "lo que hizo la IA".

## 2. Tokens

```css
:root {
  /* Superficies (negro azulado → gris carbón) */
  --bg-0: #0A0C11;   /* fondo de la ventana, barra de título */
  --bg-1: #0F1218;   /* paneles */
  --bg-2: #151922;   /* elementos elevados: inputs, tarjetas, menús */
  --bg-3: #1C212C;   /* hover */
  --bg-4: #242A37;   /* activo / pressed */
  --border: #1F2430;
  --border-strong: #2C3342;

  /* Texto */
  --text-1: #E6E8EE; /* principal (blanco suave) */
  --text-2: #A0A7B8; /* secundario */
  --text-3: #6C7386; /* terciario, placeholders */

  /* Acentos */
  --accent: #4F7DFF;        /* cobalto: foco, selección, acción primaria */
  --accent-soft: rgb(79 125 255 / .14);
  --agent: #9381FF;         /* violeta: actividad del agente */
  --agent-soft: rgb(147 129 255 / .14);

  /* Estados */
  --success: #3DBE84;  --success-soft: rgb(61 190 132 / .14);
  --error:   #F0616D;  --error-soft:   rgb(240 97 109 / .14);
  --warning: #E7B55B;  --warning-soft: rgb(231 181 91 / .14);

  /* Diff */
  --diff-add: rgb(61 190 132 / .12);  --diff-del: rgb(240 97 109 / .12);

  /* Forma */
  --radius-sm: 4px; --radius: 6px; --radius-lg: 10px;
  --shadow-pop: 0 8px 24px rgb(0 0 0 / .35), 0 0 0 1px var(--border-strong);

  /* Movimiento */
  --ease: cubic-bezier(.2, .8, .2, 1);
  --dur-fast: 120ms; --dur: 200ms;
}
```

Tema claro: previsto en tokens (mismos nombres), no en la v1.

### Tipografía (empaquetada localmente, licencia OFL)

| Uso | Fuente | Tamaño / peso |
|---|---|---|
| UI | Inter | 13 px / 400–500; etiquetas de sección 11 px / 600, mayúsculas, tracking 0,06em |
| Títulos de panel | Inter | 13 px / 600 |
| Código, rutas, comandos | JetBrains Mono | 12,5 px / 400, ligaduras opcionales |

### Espaciado y rejilla
Escala de 4 px (4, 8, 12, 16, 24, 32). Alturas: barra de título 36, cabecera de panel 36, fila de lista 28, barra de estado 24, input del chat ≥ 88.

## 3. Disposición

```
┌ Barra de título: logo · selector de proyecto · búsqueda (Ctrl+K) · estado del modelo · ventana ┐
├──────────┬───────────────────────┬──────────────┬──────────────────────────────┤
│ Sidebar  │ Chat                  │ Actividad    │ Editor (pestañas + diff)     │
│ 240 px   │ ≥ 420 px              │ 300 px       │ flexible                     │
│ plegable │                       │ plegable     ├──────────────────────────────┤
│          │                       │              │ Terminal (pestañas) plegable │
├──────────┴───────────────────────┴──────────────┴──────────────────────────────┤
│ Barra de estado: rama git · modelo · GPU % · tok/s · errores · modo de permisos  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Todos los separadores son arrastrables; doble clic restablece; tamaños persistidos por proyecto.
- **Presets** (Ctrl+1/2/3): *Agente* (sidebar + chat + actividad, editor oculto: para quien no programa), *IDE* (sidebar + editor + terminal, chat a la derecha), *Completo* (las cuatro zonas).
- Por debajo de 1280 px el panel de actividad se integra como sección plegable encima del composer.

## 4. Componentes clave

### Panel de actividad
- Agrupado por fase (ANÁLISIS · PLANIFICACIÓN · EJECUCIÓN · VERIFICACIÓN), cada grupo con contador `3/5` y duración.
- Fila de paso: icono de estado (○ pendiente, anillo violeta girando = en curso, ✓ verde, ✕ rojo, ⊘ gris cancelado) · icono de herramienta · título · objetivo en mono (`src/App.tsx`, `npm install`) · duración real a la derecha.
- Pasos de edición muestran `+84 −12`; los comandos tienen un desplegable con la salida en vivo.
- La fila en curso tiene una línea de progreso violeta de 1 px en la parte inferior (indeterminada salvo que haya progreso real, p. ej. descargas).
- **Solicitud de aprobación**: tarjeta fija arriba del panel con borde ámbar, comando completo y botones *Permitir una vez / Siempre en este proyecto / Denegar*.
- Estado del modelo arriba: "Generando · 31 tok/s" o "Razonando · 4 s" (sin mostrar el contenido del razonamiento).

### Chat
- Mensajes del usuario alineados a la izquierda con fondo `--bg-2` (no burbujas de mensajería); respuestas del agente sin fondo, con borde izquierdo violeta de 2 px mientras se generan.
- Llamadas a herramientas en línea como *chips* compactos (icono + verbo + objetivo), que enlazan al paso en el panel de actividad.
- Bloques de código con cabecera (lenguaje, ruta si existe, Copiar, Abrir en editor).
- **Tarjeta de cambios** al final de cada tarea: lista de archivos con `+/−`, *Ver diff*, *Aceptar todo*, *Rechazar todo*.
- Composer: textarea autoexpandible, `@` para referenciar archivos del proyecto (autocompletado fuzzy), `/` para comandos, adjuntos como tarjetas compactas encima del texto, selector de modelo y de modo de permisos, botón Enviar que se convierte en **Detener** durante la ejecución.

### Tarjeta de adjunto
Icono por formato con color de categoría tenue (PDF rojo, hoja verde, imagen cobalto, código gris) · nombre truncado por el centro · extensión + tamaño · estado (*Procesando…* con barra, *Listo*, *Error* con tooltip del motivo) · botón ✕. Las imágenes muestran miniatura. Clic → vista previa en un modal.

### Explorador
Árbol virtualizado, iconos por tipo, puntos de color para archivos modificados por el agente (violeta) o por el usuario (cobalto), menú contextual (abrir, renombrar, revelar en el Explorador de Windows, mencionar en el chat, eliminar).

### Editor
Monaco con tema propio derivado de los tokens; pestañas con indicador de cambios sin guardar; marcas en el margen para líneas cambiadas por el agente; botón de diff en la pestaña cuando hay un changeset pendiente.

### Estados vacíos
Una frase útil + una acción primaria + atajos ("Abre una carpeta para empezar · Ctrl+O"). Sin ilustraciones decorativas.

### Notificaciones
Toasts abajo a la derecha, máx. 3 apilados, 4 s (los errores persisten hasta cerrarse), con acción opcional ("Ver detalle").

## 5. Movimiento
- Entrada de pasos del panel: fade + desplazamiento de 4 px, 160 ms.
- Cambio de estado de paso: el icono hace morph (anillo → check) en 200 ms.
- Paneles plegables: 200 ms `--ease`. Se respetan `prefers-reduced-motion`.

## 6. Accesibilidad
Contraste ≥ 4,5:1 para texto (verificado con los tokens de texto sobre `--bg-1`), foco visible (anillo de 2 px `--accent`), navegación completa por teclado, `aria-live="polite"` en el panel de actividad, el estado nunca se comunica solo por color (icono + texto).
