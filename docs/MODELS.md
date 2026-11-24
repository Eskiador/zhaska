# Análisis de modelos — Gemma 4 en Ollama para RTX 5060 (8 GB)

> Datos de la biblioteca oficial de Ollama (`ollama.com/library/gemma4` y `/tags`), consultados el 22-11-2026.
> Las cifras de velocidad son **estimaciones** de ingeniería; se sustituirán por mediciones reales del banco de pruebas en la Fase 4.

## 1. Qué ofrece Ollama hoy

Capacidades declaradas: **tools**, **vision**, **thinking** (y audio solo en E2B/E4B). Entrada texto + imagen en todos los tamaños; salida texto.

| Tamaño | Tipo | Contexto | Variante recomendada | Descarga |
|---|---|---|---|---|
| E2B | denso "efectivo" (edge) | 128K | `gemma4:e2b-it-qat` | 4,3 GB |
| E4B | denso "efectivo" (edge) — es `gemma4:latest` | 128K | `gemma4:e4b-it-qat` | 6,1 GB |
| 12B | denso | 256K | `gemma4:12b-it-qat` | 7,2 GB |
| 26B A4B | MoE, ~4B parámetros activos por token | 256K | `gemma4:26b-a4b-it-qat` | 16 GB |
| 31B | denso | 256K | `gemma4:31b-it-qat` | 19 GB |

Variantes de cuantización: `qat` (entrenada con cuantización, 4 bits; la mejor relación calidad/tamaño), `q4_K_M`, `q8_0`, `bf16`. Las variantes `mlx`/`nvfp4`/`mxfp8` son para Apple Silicon y **no aplican** a Windows + NVIDIA. Los tags `cloud` se ejecutan en servidores de Ollama: **quedan excluidos** porque rompen la premisa local-first.

Notas de la ficha relevantes para el agente:
- Thinking se activa mediante el system prompt (`<|think|>`), y Ollama gestiona la plantilla; en la API se usa `think: true`. Los pensamientos de turnos anteriores **no deben** reinyectarse en el historial.
- Muestreo recomendado: `temperature 1.0, top_p 0.95, top_k 64`. Para el agente usaremos una temperatura más baja en llamadas a herramientas (a calibrar en el banco de pruebas).
- Las imágenes deben ir **antes** del texto en el mensaje.

## 2. Presupuesto de memoria en una RTX 5060 de 8 GB

- VRAM utilizable real ≈ **7–7,3 GB** (Windows y el escritorio ocupan 0,5–1 GB).
- Lo que ocupa un modelo cargado = pesos + caché KV (crece con `num_ctx`) + buffers de cómputo + codificador de visión.
- Gemma 4 usa atención con ventana deslizante (1024 tokens en los modelos grandes) en la mayoría de capas, por lo que la caché KV crece bastante menos que en un modelo de atención global pura. Con `OLLAMA_FLASH_ATTENTION=1` y `OLLAMA_KV_CACHE_TYPE=q8_0` se reduce aproximadamente a la mitad.
- Lo que no cabe en VRAM, Ollama lo reparte por capas en RAM y CPU. La velocidad cae en proporción a lo que queda en CPU (DDR4 dual channel ≈ 40–50 GB/s frente a ~448 GB/s de la GDDR7 de la 5060).

## 3. Evaluación para este equipo

| Modelo | ¿Cabe en GPU? (num_ctx 32K) | Generación estimada | Calidad agente/código | Veredicto |
|---|---|---|---|---|
| `e2b-it-qat` | Sí, holgado | muy alta (>80 tok/s) | baja para tareas multi-paso | Solo tareas auxiliares (títulos, resúmenes) |
| `e4b-it-qat` | Sí | alta (~50–80 tok/s) | aceptable en tareas cortas | **Perfil Rápido** y modelo de visión auxiliar |
| `12b-it-qat` | Casi: ~85–95 % en GPU | media (~20–35 tok/s) | buena | **Perfil Equilibrado — recomendado por defecto** |
| `26b-a4b-it-qat` | No: ~40 % GPU, resto RAM | media-baja (~10–20 tok/s); el MoE lo hace viable porque solo lee ~4B parámetros por token | la mejor alcanzable | **Perfil Calidad** solo con ≥ 32 GB RAM. **Descartado en tu equipo (16 GB)** |
| `31b-it-qat` | No: ~35 % GPU | baja (~2–5 tok/s); denso, todo se lee en cada token | muy buena | No recomendado en este hardware |

### Recomendación

**Por defecto: `gemma4:12b-it-qat`, `num_ctx` 32 768, flash attention + caché KV q8_0.**

Es el punto de equilibrio: la mayor parte del modelo en GPU, contexto suficiente para un bucle agéntico con varios archivos, y calidad claramente superior a E4B en planificación y en llamadas a herramientas encadenadas.

Con 16 GB de RAM (confirmado el 22-11-2026) se descarta `gemma4:26b-a4b-it-qat`: sus 16 GB de pesos, más ~4–5 GB de Windows y ~1 GB de la app, no caben en 16 + 7 GB sin paginar a disco, lo que lo haría inutilizable. Si en el futuro amplías a 32 GB, el banco de pruebas lo evaluará como perfil Calidad.

### Factores que más afectan en un agente (no solo tok/s)

1. **Prefill**: cada paso del bucle añade resultados de herramientas (archivos leídos, salidas de comandos). Con descarga parcial a CPU, procesar 5–10K tokens nuevos puede tardar varios segundos. Mitigación: prefijo estable para reutilizar la caché KV, resultados truncados y compactación (ARCHITECTURE §6.5).
2. **Precisión de las llamadas**: un 95 % de llamadas válidas por paso significa que en 30 pasos habrá ~1–2 fallos; por eso hay validación y auto-reparación.
3. **Cambio de modelo**: cargar otro modelo expulsa el anterior de la VRAM (segundos). El modelo de visión auxiliar solo se carga cuando hace falta.

## 4. Pendiente de confirmar en la Fase 4

- [x] RAM total del equipo: **16 GB** → perfiles disponibles: Rápido (E4B) y Equilibrado (12B).
- [ ] tok/s de generación y de prefill reales de 12B y 26B-A4B en la RTX 5060.
- [ ] % de llamadas válidas por protocolo (nativo frente a JSON estructurado) en la suite del banco de pruebas.
- [ ] Compatibilidad de `think: true` combinado con `tools` y con `format` en la versión de Ollama instalada.
- [ ] Versión mínima de Ollama necesaria para Gemma 4 (la ficha no la indica; se detectará por error de carga y se pedirá actualizar).

## 5. Mediciones reales (22-11-2026)

### Mac de desarrollo (Apple M4, 16 GB de memoria unificada, Ollama 0.30.8)

Banco de pruebas (`tests/eval/bench.eval.ts`, contexto 32K):

| Modelo | GPU % | Carga | Generación | Prefill | Llamadas válidas (nativas) | Llamadas válidas (JSON) |
|---|---|---|---|---|---|---|
| `gemma4:12b-it-qat` | 100 | 1,8 s | 12,3 tok/s | 98 tok/s | 5/5 | 3/5 (criterio estricto antiguo) |

Evaluación del agente (`npm run eval:agent`, 6 tareas reales sobre proyectos temporales):

| Modelo | Protocolo | Éxito | Pasos por tarea |
|---|---|---|---|
| `gemma4:12b-it-qat` | nativo | **5/6 (83 %)** | 1–5 |
| `llama3` 8B (sin entrenamiento para herramientas) | JSON | 2/6 (33 %) | 2–12 |

El único fallo de Gemma 4 fue renombrar una función con un nombre distinto del pedido (`calcIva` en vez de `conIva`), aunque de forma coherente en los dos archivos.
Conclusión: **se confirma `gemma4:12b-it-qat` con herramientas nativas como modelo por defecto**. En este Mac el prefill (~100 tok/s) hace lentas las tareas que leen mucho; en la RTX 5060 se espera bastante más rápido.

Pendiente: repetir ambas mediciones en el PC con Windows (RTX 5060 8 GB, 16 GB RAM).

### Si no se puede descargar desde el servidor de Ollama

**ZHASKA lo resuelve sola** (Configuración → Ollama → *Origen de las descargas*, por defecto *Automático*): si el servidor de descargas de Ollama falla por la red, descarga la misma versión oficial de Google desde Hugging Face (`google/gemma-4-<tamaño>-it-qat-q4_0-gguf`), crea el modelo con el nombre del catálogo usando el *renderer* y el *parser* de Gemma 4 de Ollama (`/api/create`) y quita la copia intermedia (comparten archivos). Verificado con un servidor simulado y con el Ollama real del Mac: el modelo queda con `tools`, `thinking`, `vision` y `audio`.

Procedimiento manual equivalente:

El 22-11-2026 la red del usuario bloqueaba el almacenamiento de descargas de Ollama (Cloudflare R2) mientras el resto de Internet funcionaba (posible bloqueo temporal de direcciones de Cloudflare por el proveedor). Alternativa probada, con los mismos pesos oficiales de Google y sin espacio extra:

```bash
ollama pull hf.co/google/gemma-4-12B-it-qat-q4_0-gguf
printf 'FROM hf.co/google/gemma-4-12B-it-qat-q4_0-gguf:latest\nRENDERER gemma4\nPARSER gemma4\n' > Modelfile
ollama create gemma4:12b-it-qat -f Modelfile
```

Sin `RENDERER`/`PARSER`, Ollama importa la plantilla genérica del GGUF y el modelo **pierde** las capacidades `tools` y `thinking`.
