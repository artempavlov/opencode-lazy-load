# opencode-lazy-load

Plugin de OpenCode que reduce el overhead de tokens de herramientas MCP en 88-90% mediante interceptación de cuerpo HTTP y carga bajo demanda.

## Problema

9 servidores MCP × ~250 definiciones de herramientas = ~40-70k tokens consumidos por conversación antes del primer mensaje del usuario. Esto desperdicia la ventana de contexto y aumenta los costos de API.

## Solución

Este plugin intercepta `globalThis.fetch` para eliminar TODAS las definiciones de herramientas de las solicitudes HTTP al LLM. El LLM solo ve `load_tool` como herramienta llamable más 7 herramientas ALWAYS_VISIBLE. Cuando el LLM necesita una herramienta, llama a `load_tool({name: "toolname"})` para obtener instrucciones completas, luego llama a la herramienta real directamente.

## Resultados

| Métrica | Antes | Después |
|---------|-------|---------|
| Herramientas visibles para LLM | ~113 (13 integradas + ~100 MCP) | 20 (load_tool + 7 ALWAYS_VISIBLE + 12 integradas) |
| Overhead de tokens | ~40-70k | ~6-8k |
| Ahorro | - | ~88-90% |
| Servidores MCP conectados | 9 | 9 (siguen activos) |

## Arquitectura: Defensa de 3 Capas

```
Capa 1: Interceptación de Cuerpo HTTP (mecánico)
- Elimina todas las herramientas excepto load_tool + 7 ALWAYS_VISIBLE
- Confiabilidad: 100%

Capa 2: Transformación SSE (mecánico)
- Redirige llamadas MCP directas → load_tool
- Confiabilidad: 100%

Capa 3: Lista de Punteros (semi-mecánico)
- La descripción de load_tool lista todas las herramientas disponibles
- Confiabilidad: ~90% (depende del LLM)
```

## Herramientas ALWAYS_VISIBLE

7 herramientas core que NUNCA se eliminan del cuerpo HTTP:
```
bash, read, edit, write, task, glob, grep
```
Estas funcionan directamente sin `load_tool`. Todas las demás requieren `load_tool`.

## Instalación

1. Copiar `index.ts` a `.opencode/plugins/lazy-load/`
2. Agregar a la configuración global `~/.config/opencode/opencode.jsonc`:
```jsonc
{
  "plugin": ["C:\\path\\to\\opencode-lazy-load"]
}
```
3. Reiniciar OpenCode Desktop

## Uso

**Patrón obligatorio de 2 pasos:**

```typescript
// Paso 1: Cargar definición de la herramienta
load_tool({name: "supabase_list_tables"})

// Paso 2: Ejecutar la herramienta real
supabase_list_tables({schema: "public"})
```

**Listar todas las herramientas disponibles:**
```typescript
load_tool({name: "__list__"})
```

**Excepción:** 7 herramientas ALWAYS_VISIBLE funcionan directo (sin load_tool):
`bash, read, edit, write, task, glob, grep`

## Herramientas Disponibles

Después de cargar, estas herramientas son accesibles via `load_tool`:

**Integradas (siempre visibles, no necesitan carga):**
bash, read, edit, write, task, glob, grep

**Herramientas MCP (cargar con load_tool):**
supabase_*, memory_*, context7_*, playwright_*, chrome-devtools_*, sequential-thinking_*

## Comparación

| Característica | opencode-lazy-load | omarwaly-ai/opencode-lazy-loading | keybrdist/opencode-lazy-loader |
|----------------|-------------------|-----------------------------------|-------------------------------|
| ALWAYS_VISIBLE | ✅ 7 herramientas | ❌ | N/A |
| Comando __list__ | ✅ | ❌ | N/A |
| Defensa de 3 capas | ✅ | ❌ (2 capas) | ❌ |
| Proxy MCP | ✅ Completo | ⚠️ Parcial | ✅ Propósito diferente |
| Ahorro de tokens | 88-90% | 95-98% | N/A |
| Dependencias | 1 | 0 | 3 |

## Cómo Funciona

1. **Interceptación de Solicitudes**: Elimina todas las definiciones de herramientas del cuerpo HTTP excepto `load_tool` y herramientas ALWAYS_VISIBLE
2. **Lista de Punteros**: Agrega nombres de herramientas disponibles a la descripción de `load_tool`
3. **Transformación SSE**: Intercepta respuestas del LLM y redirige llamadas directas a herramientas hacia `load_tool` cuando aún no se han cargado
4. **Seguimiento de Turnos**: Rastrea qué herramientas se han cargado por turno, se limpia al completar la conversación

## Limitaciones Conocidas

- **Coerción de tipos de argumentos**: Arrays/booleans pueden llegar como strings a servidores MCP (bug de OpenCode #34652)
- **Comportamiento del LLM**: ~10% de llamadas omiten `load_tool` primero (la transformación SSE las atrapa)
- **Herramientas MCP evitan el hook `tool.definition`**: Bug de OpenCode #31670 (PR #31671 pendiente)

## Licencia

MIT

## Construido con

Desarrollo asistido por IA (OpenCode + Mimo v2.5).

## Atribuciones

Originalmente basado en [omarwaly-ai/opencode-lazy-loading](https://github.com/omarwaly-ai/opencode-lazy-loading) (MIT). Se fusionaron las siguientes mejoras:

- **DSML parsing**: Convierte tool calls de modelos DeepSeek/Qwen a formato estándar
- **Schema normalization**: Corrige argumentos con tipos incorrectos (strings → booleans/números)
- **Case-insensitive resolution**: Resolución de nombres de herramientas sin importar mayúsculas/minúsculas
- **Native tool index tracking**: Tracking robusto de índices en tool calls interleaved

### Changelog

- **2026-07-30**: Merge con omarwaly-ai — DSML, schema normalization, case-insensitive, native tracking
- **2026-07-29**: Versión inicial con ALWAYS_VISIBLE, __list__, logging
