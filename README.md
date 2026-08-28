# opencode-lazy-load

Plugin de OpenCode que reduce el overhead de tokens de herramientas MCP en 88-90% mediante interceptación de cuerpo HTTP y carga bajo demanda.

## Problema

9 servidores MCP × ~250 definiciones de herramientas = ~40-70k tokens consumidos por conversación antes del primer mensaje del usuario. Esto desperdicia la ventana de contexto y aumenta los costos de API.

## Solución

Este plugin intercepta `globalThis.fetch` para eliminar las definiciones completas de herramientas de las solicitudes HTTP al LLM. El LLM recibe únicamente `load_tool` y una lista compacta de nombres y descripciones breves. Cuando necesita una herramienta, puede cargar su esquema o ejecutarla mediante el gateway.

## Resultados

| Métrica | Antes | Después |
|---------|-------|---------|
| Herramientas visibles para LLM | ~113 (13 integradas + ~100 MCP) | 1 gateway + lista compacta |
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

## Instalación

1. Clonar este repositorio en una ruta local.
2. Agregar la ruta del repositorio a `~/.config/opencode/opencode.jsonc`:
```jsonc
{
  "plugin": ["/absolute/path/to/opencode-lazy-load"]
}
```
3. Reiniciar OpenCode.

El plugin usa `index.ts` como entrada y carga `lib/lazy-load-core.ts` desde el mismo repositorio. Si se copia el plugin manualmente a `.opencode/plugins/`, deben copiarse `index.ts` y `lib/lazy-load-core.ts`, conservando la estructura de directorios. No coloque el archivo auxiliar dentro de `.opencode/plugins/`, porque OpenCode puede intentar cargarlo como un plugin separado.

## Uso

**Carga explícita del esquema:**

```typescript
load_tool({name: "supabase_list_tables"})
```

**Ejecución directa mediante el gateway:**

```typescript
load_tool({name: "supabase_list_tables", args: {schema: "public"}})
```

**Listar todas las herramientas disponibles:**
```typescript
load_tool({name: "__list__"})
```

El plugin también intercepta una llamada directa a una herramienta no cargada y la convierte automáticamente en una llamada de carga.

## Herramientas Disponibles

Después de cargar, estas herramientas son accesibles via `load_tool`:

**Herramientas integradas y de plugins:**
Se cargan bajo demanda mediante `load_tool`.

**Herramientas MCP (cargar con load_tool):**
supabase_*, memory_*, context7_*, playwright_*, chrome-devtools_*, sequential-thinking_*

## Comparación

| Característica | opencode-lazy-load | omarwaly-ai/opencode-lazy-loading | keybrdist/opencode-lazy-loader |
|----------------|-------------------|-----------------------------------|-------------------------------|
| Gateway único | ✅ | ❌ | N/A |
| Comando __list__ | ✅ | ❌ | N/A |
| Defensa de 3 capas | ✅ | ❌ (2 capas) | ❌ |
| Proxy MCP | ✅ Completo | ⚠️ Parcial | ✅ Propósito diferente |
| Ahorro de tokens | 88-90% | 95-98% | N/A |
| Dependencias | 1 | 0 | 3 |

## Cómo Funciona

1. **Interceptación de Solicitudes**: Elimina las definiciones completas de herramientas del cuerpo HTTP excepto `load_tool` y conserva las herramientas nativas que no son function tools
2. **Lista de Punteros**: Agrega nombres de herramientas disponibles a la descripción de `load_tool`
3. **Transformación SSE**: Intercepta respuestas del LLM y redirige llamadas directas a herramientas hacia `load_tool` cuando aún no se han cargado
4. **Seguimiento de Turnos**: Rastrea qué herramientas se han cargado por turno, se limpia al completar la conversación

## Protocolos compatibles

- OpenAI Responses API (`/responses`), incluido el formato plano de sus function tools.
- OpenAI Chat Completions (`/chat/completions`).
- Anthropic Messages (`/v1/messages`).
- Vertex AI Anthropic (`rawPredict` y `streamRawPredict`).

## Pruebas

```bash
bun test tests/lazy-load-core.test.ts
```

## Limitaciones Conocidas

- **Estado por sesión**: cuando un proveedor no envía un identificador de sesión, se usa el primer mensaje de usuario como fallback.
- **Herramientas alojadas por el proveedor**: las herramientas no-function se conservan para no romper funciones nativas del proveedor.

## Licencia

MIT

## Construido con

Desarrollo asistido por IA (OpenCode + Mimo v2.5).

## Atribuciones

Originalmente basado en [omarwaly-ai/opencode-lazy-loading](https://github.com/omarwaly-ai/opencode-lazy-loading) (MIT). Se fusionaron las siguientes mejoras:

- **Schema normalization**: Corrige argumentos con tipos incorrectos (strings → booleans/números)
- **Case-insensitive resolution**: Resolución de nombres de herramientas sin importar mayúsculas/minúsculas
- **Native tool index tracking**: Tracking robusto de índices en tool calls interleaved

### Changelog

- **2026-08-28**: Soporte para Responses API, Anthropic, Vertex Anthropic, ejecución mediante gateway y pruebas de regresión.
- **2026-07-30**: Merge con omarwaly-ai — DSML, schema normalization, case-insensitive, native tracking
- **2026-07-29**: Versión inicial con ALWAYS_VISIBLE, __list__, logging
