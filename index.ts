import { tool, type Plugin } from "@opencode-ai/plugin"
import {
  bodyText,
  createSseTransform,
  isLoadToolName,
  protocolForUrl,
  sessionKey,
  ToolRegistry,
  transformJsonResponseText,
  transformRequestBody,
  TurnStore,
} from "./lib/lazy-load-core"

const registry = new ToolRegistry()
const turns = new TurnStore()

let originalFetch: typeof fetch | undefined
let fetchWrapped = false

function loadToolDescription(): string {
  const pointers = registry.pointerList()
  return [
    "Gateway tool. Use it to load or execute another tool.",
    "",
    "Available tools:",
    pointers || "(Tool list is populated when the first model request is prepared.)",
    "",
    'Load schema: load_tool({name: "toolname"})',
    'Execute: load_tool({name: "toolname", args: {param: value}})',
  ].join("\n")
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

function wrapFetch(directory: string): void {
  if (fetchWrapped) return
  fetchWrapped = true
  originalFetch = globalThis.fetch

  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = requestUrl(input)
    const protocol = protocolForUrl(url)
    if (!protocol || !init?.body) return originalFetch!.call(globalThis, input, init)

    const text = await bodyText(init.body)
    if (!text) return originalFetch!.call(globalThis, input, init)

    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      return originalFetch!.call(globalThis, input, init)
    }

    const key = sessionKey(init, body, protocol, directory)
    const transformed = transformRequestBody(body, protocol, registry)
    const nextInit = transformed.changed ? { ...init, body: JSON.stringify(transformed.body) } : init
    const response = await originalFetch!.call(globalThis, input, nextInit)
    const contentType = response.headers.get("content-type") || ""
    const headers = new Headers(response.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    headers.delete("transfer-encoding")
    if (!contentType.includes("text/event-stream") || !response.body) {
      if (!transformed.changed) return response
      const responseBody = await response.text()
      return new Response(
        transformJsonResponseText(responseBody, protocol, registry, turns, key, transformed.loadToolName),
        { status: response.status, statusText: response.statusText, headers },
      )
    }

    const stream = response.body.pipeThrough(
      createSseTransform(protocol, registry, turns, key, transformed.loadToolName),
    )
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

const LazyLoadPlugin: Plugin = async (input) => {
  wrapFetch(input.directory)

  return {
    tool: {
      load_tool: tool({
        description: loadToolDescription(),
        args: {
          name: tool.schema.string().describe("Tool name to load or execute"),
          args: tool.schema.any().optional().describe("Arguments object to execute the tool with"),
        },
        async execute(args) {
          if (args.name === "__list__") {
            const categories = registry.categories()
            return {
              title: "Available tools",
              output: [
                "=== Built-in tools ===",
                categories.builtIn.join(", "),
                "",
                "=== MCP tools ===",
                categories.mcp.join(", "),
              ].join("\n"),
            }
          }

          const known = registry.resolve(args.name)
          const name = known?.name || args.name
          const description = registry.description(name)
          if (!description) {
            return {
              title: `Unknown tool: ${args.name}`,
              output: `No instructions found for ${args.name}. Available tools: ${registry.allNames().join(", ")}`,
            }
          }

          const schema = registry.schema(name)
          let output = description
          if (schema !== undefined) output += `\n\n--- Parameter schema ---\n${JSON.stringify(schema, null, 2)}`
          return { title: `Loaded: ${name}`, output }
        },
      }),
    },
    async "tool.definition"(input, output) {
      if (isLoadToolName(input.toolID)) return
      registry.registerDefinition(input.toolID, output.description, (output as any).jsonSchema)
    },
  }
}

export default {
  id: "opencode-lazy-load",
  server: LazyLoadPlugin,
}
