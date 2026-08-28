import { describe, expect, it } from "bun:test"
import {
  createSseTransform,
  protocolForUrl,
  sessionKey,
  ToolRegistry,
  toolName,
  transformJsonResponseText,
  transformRequestBody,
  transformSseText,
  TurnStore,
} from "../lib/lazy-load-core"

function event(value: any): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function responsesFunctionCall(name: string, argumentsJson: string, index = 0): string {
  return event({
    type: "response.output_item.added",
    output_index: index,
    item: {
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name,
      arguments: "",
    },
  }) + event({
    type: "response.function_call_arguments.delta",
    output_index: index,
    item_id: `fc_${index}`,
    delta: argumentsJson,
  }) + event({
    type: "response.output_item.done",
    output_index: index,
    item: {
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name,
      arguments: argumentsJson,
      status: "completed",
    },
  }) + event({
    type: "response.completed",
    response: { output: [{ type: "function_call", name }] },
  })
}

function chatFunctionCall(name: string, argumentsJson: string): string {
  return event({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_0",
          type: "function",
          function: { name, arguments: argumentsJson },
        }],
      },
    }],
  }) + event({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
}

function registryWithBash(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.registerDefinition(
    "bash",
    "Run shell commands.",
    { type: "object", properties: { command: { type: "string" } } },
  )
  return registry
}

describe("lazy-load request transformation", () => {
  it("handles flat Responses tools and includes MCP pointers", () => {
    const registry = registryWithBash()
    const body = {
      tools: [
        { type: "function", name: "load_tool", description: "gateway", parameters: { type: "object" } },
        { type: "function", name: "bash", description: "Run shell commands", parameters: { type: "object" } },
        { type: "function", name: "context7_query-docs", description: "Query current documentation", parameters: { type: "object" } },
      ],
    }

    const result = transformRequestBody(body, "responses", registry)

    expect(result.changed).toBe(true)
    expect(body.tools.map(toolName)).toEqual(["load_tool"])
    expect(body.tools[0].description).toContain("bash")
    expect(body.tools[0].description).toContain("context7_query-docs")
    expect(registry.resolve("context7_query-docs")?.kind).toBe("mcp")
  })

  it("rewrites Responses allowed-tools choices to the gateway", () => {
    const registry = registryWithBash()
    const body = {
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "bash" }],
      },
      tools: [
        { type: "function", name: "load_tool", parameters: { type: "object" } },
        { type: "function", name: "bash", parameters: { type: "object" } },
      ],
    }

    transformRequestBody(body, "responses", registry)

    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "load_tool" }],
    })
  })

  it("handles nested Chat Completions tools", () => {
    const registry = registryWithBash()
    const body = {
      tools: [
        { type: "function", function: { name: "load_tool", description: "gateway", parameters: { type: "object" } } },
        { type: "function", function: { name: "bash", description: "Run shell commands", parameters: { type: "object" } } },
      ],
    }

    transformRequestBody(body, "chat", registry)

    expect(body.tools.map(toolName)).toEqual(["load_tool"])
    expect(body.tools[0].function.description).toContain("bash")
  })

  it("keeps named Anthropic provider tools intact", () => {
    const body = {
      tool_choice: { type: "tool", name: "bash" },
      tools: [
        { name: "load_tool", description: "gateway", input_schema: { type: "object" } },
        { type: "bash_20250124", name: "bash", description: "Run a shell command" },
      ],
    }

    transformRequestBody(body, "anthropic", new ToolRegistry())

    expect(body.tools.map(toolName)).toEqual(["load_tool", "bash"])
    expect(body.tool_choice).toEqual({ type: "tool", name: "load_tool" })
  })

  it("does not strip a request when the gateway tool is absent", () => {
    const body = { tools: [{ type: "function", name: "bash" }] }
    const result = transformRequestBody(body, "responses", new ToolRegistry())
    expect(result.changed).toBe(false)
    expect(body.tools).toHaveLength(1)
  })
})

describe("lazy-load Responses stream", () => {
  it("rewrites execute-mode load_tool into the real tool call", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    const args = JSON.stringify({ name: "bash", args: { command: "pwd" } })
    const transformed = transformSseText(
      responsesFunctionCall("load_tool", args),
      "responses",
      registry,
      turns,
      "session:test",
    )
    const values = transformed
      .split("\n\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, "")))
    const done = values.find((value) => value.type === "response.output_item.done")
    expect(done.item.name).toBe("bash")
    expect(done.item.arguments).toBe(JSON.stringify({ command: "pwd" }))
    expect(turns.has("session:test", "bash")).toBe(true)
  })

  it("rewrites a non-streaming Responses function call", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    const response = transformJsonResponseText(
      JSON.stringify({
        output: [{ type: "function_call", name: "bash", arguments: JSON.stringify({ command: "pwd" }) }],
      }),
      "responses",
      registry,
      turns,
      "session:test",
    )
    expect(JSON.parse(response).output[0].name).toBe("load_tool")
    expect(turns.has("session:test", "bash")).toBe(true)
  })

  it("flushes a Responses call before response.completed when done is missing", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    const input = event({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_0", call_id: "call_0", name: "bash", arguments: "" },
    }) + event({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc_0",
      delta: JSON.stringify({ command: "pwd" }),
    }) + event({
      type: "response.completed",
      response: { output: [{ type: "function_call", id: "fc_0", call_id: "call_0", name: "bash", arguments: JSON.stringify({ command: "pwd" }) }] },
    }) + event({ type: "done" })
    const values = transformSseText(input, "responses", registry, turns, "session:test")
      .split("\n\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, "")))
    const outputIndex = values.findIndex((value) => value.type === "response.output_item.done")
    const completedIndex = values.findIndex((value) => value.type === "response.completed")
    expect(outputIndex).toBeGreaterThanOrEqual(0)
    expect(outputIndex).toBeLessThan(completedIndex)
    expect(values[outputIndex].item.name).toBe("load_tool")
  })

  it("uses wire JSON schemas for built-in argument normalization", () => {
    const registry = new ToolRegistry()
    const turns = new TurnStore()
    registry.registerDefinition("update", "Update a record", { decodeUnknownEffect: "runtime decoder" })
    transformRequestBody({
      tools: [
        { type: "function", name: "load_tool", parameters: { type: "object" } },
        {
          type: "function",
          name: "update",
          parameters: { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
        },
      ],
    }, "responses", registry)
    turns.add("session:test", "update")
    const response = transformJsonResponseText(
      JSON.stringify({ output: [{ type: "function_call", name: "update", arguments: JSON.stringify({ tags: "[]" }) }] }),
      "responses",
      registry,
      turns,
      "session:test",
    )
    expect(JSON.parse(response).output[0].arguments).toBe(JSON.stringify({ tags: [] }))
  })

  it("clears state after a non-tool Responses result", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    turns.add("session:test", "bash")
    transformJsonResponseText(
      JSON.stringify({ output: [{ type: "message", content: [] }] }),
      "responses",
      registry,
      turns,
      "session:test",
    )
    expect(turns.has("session:test", "bash")).toBe(false)
  })

  it("keeps a tool loaded across Responses requests in one turn", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    const key = "session:test"
    const first = transformSseText(
      responsesFunctionCall("bash", JSON.stringify({ command: "pwd" })),
      "responses",
      registry,
      turns,
      key,
    )
    const second = transformSseText(
      responsesFunctionCall("bash", JSON.stringify({ command: "pwd" })),
      "responses",
      registry,
      turns,
      key,
    )
    const firstDone = first.split("\n\n").filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, ""))).find((value) => value.type === "response.output_item.done")
    const secondDone = second.split("\n\n").filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, ""))).find((value) => value.type === "response.output_item.done")
    expect(firstDone.item.name).toBe("load_tool")
    expect(secondDone.item.name).toBe("bash")
  })

  it("works when SSE boundaries split every event", async () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    const input = responsesFunctionCall("load_tool", JSON.stringify({ name: "bash" }))
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const character of input) controller.enqueue(encoder.encode(character))
        controller.close()
      },
    })
    const result = await new Response(source.pipeThrough(createSseTransform("responses", registry, turns, "session:test"))).text()
    expect(result).toContain('"name":"load_tool"')
    expect(result).toContain('\\"name\\":\\"bash\\"')
  })
})

describe("lazy-load Chat and Anthropic streams", () => {
  it("rewrites Chat Completions execute mode", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    const transformed = transformSseText(
      chatFunctionCall("load_tool", JSON.stringify({ name: "bash", args: { command: "pwd" } })),
      "chat",
      registry,
      turns,
      "session:test",
    )
    expect(transformed).toContain('"name":"bash"')
    expect(transformed).toContain('"arguments":"{\\"command\\":\\"pwd\\"}"')
  })

  it("clears Chat state after terminal non-tool finishes", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    turns.add("session:test", "bash")
    transformSseText(
      event({ choices: [{ delta: {}, finish_reason: "length" }] }),
      "chat",
      registry,
      turns,
      "session:test",
    )
    expect(turns.has("session:test", "bash")).toBe(false)
  })

  it("rewrites Anthropic tool_use blocks", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    const input = event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool_0", name: "bash", input: {} },
    }) + event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
    }) + event({ type: "content_block_stop", index: 0 })
    const transformed = transformSseText(input, "anthropic", registry, turns, "session:test")
    expect(transformed).toContain('"name":"load_tool"')
    expect(transformed).toContain('\\"name\\":\\"bash\\"')
    expect(transformed).not.toContain('{}{')
  })

  it("rewrites Anthropic execute mode without duplicating the initial empty input", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    const input = event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool_0", name: "load_tool", input: {} },
    }) + event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ name: "bash", args: { command: "pwd" } }) },
    }) + event({ type: "content_block_stop", index: 0 })
    const transformed = transformSseText(input, "anthropic", registry, turns, "session:test")
    expect(transformed).toContain('"name":"bash"')
    expect(transformed).toContain('\\"command\\":\\"pwd\\"')
    expect(transformed).not.toContain('{}{')
  })

  it("rewrites pre-populated Anthropic tool calls", () => {
    const registry = registryWithBash()
    const turns = new TurnStore()
    const transformed = transformSseText(
      event({
        type: "message_start",
        message: {
          content: [{ type: "tool_use", id: "tool_0", name: "bash", input: { command: "pwd" } }],
        },
      }),
      "anthropic",
      registry,
      turns,
      "session:test",
    )
    expect(transformed).toContain('"name":"load_tool"')
    expect(transformed).toContain('"input":{"name":"bash"}')
  })
})

describe("lazy-load protocol detection", () => {
  it("detects Responses, Chat Completions, and Anthropic endpoints", () => {
    expect(protocolForUrl("http://localserver:37000/v1/responses")).toBe("responses")
    expect(protocolForUrl("http://localserver:37000/v1/chat/completions")).toBe("chat")
    expect(protocolForUrl("https://api.anthropic.com/v1/messages")).toBe("anthropic")
    expect(protocolForUrl("https://vertex.googleapis.com/v1/projects/p/locations/us/publishers/anthropic/models/m:streamRawPredict")).toBe("anthropic")
    expect(protocolForUrl("https://vertex.googleapis.com/v1/projects/p/locations/us/publishers/google/models/m:streamRawPredict")).toBeUndefined()
    expect(protocolForUrl("http://localserver:37000/v1/models")).toBeUndefined()
  })
})

describe("lazy-load turn identity", () => {
  it("keeps Anthropic tool state across tool_result user messages", () => {
    const first = {
      messages: [{ role: "user", content: "Run pwd" }],
    }
    const continuation = {
      messages: [
        { role: "user", content: "Run pwd" },
        { role: "assistant", content: [{ type: "tool_use", id: "tool_0", name: "load_tool", input: { name: "bash" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_0", content: "loaded" }] },
      ],
    }
    expect(sessionKey(undefined, first, "anthropic", "/repo")).toBe(sessionKey(undefined, continuation, "anthropic", "/repo"))
  })
})
