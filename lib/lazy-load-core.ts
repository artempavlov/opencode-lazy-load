export type Protocol = "chat" | "responses" | "anthropic"
export type ToolKind = "built-in" | "mcp"

export type KnownTool = {
  name: string
  kind: ToolKind
}

type ToolMeta = {
  description: string
  schema?: any
}

export function isLoadToolName(name: string): boolean {
  return name === "load_tool" || name.endsWith("_load_tool")
}

export function toolName(entry: any): string {
  return entry?.function?.name || entry?.name || ""
}

function toolDescription(entry: any): string {
  return entry?.function?.description || entry?.description || ""
}

function toolSchema(entry: any): any {
  return entry?.function?.parameters || entry?.parameters || entry?.input_schema
}

function isFunctionToolEntry(entry: any, protocol: Protocol): boolean {
  if (entry?.function || entry?.type === "function") return true
  return protocol === "anthropic" && !entry?.type
}

function briefOf(description: string): string {
  if (!description) return ""
  const firstLine = description.split("\n")[0].trim()
  const firstSentence = description.split(".")[0]
  const candidate = (firstSentence.length <= firstLine.length ? firstSentence : firstLine)
    .replace(/\$\{[^}]*\}/g, "")
    .trim()
  if (candidate.length < 5) return ""
  return candidate.length > 80 ? `${candidate.slice(0, 77)}...` : candidate
}

export class ToolRegistry {
  private readonly builtIns = new Map<string, ToolMeta>()
  private readonly mcp = new Map<string, ToolMeta>()

  registerDefinition(name: string, description: string, schema?: any): void {
    if (!name || isLoadToolName(name)) return
    const current = this.builtIns.get(name)
    this.builtIns.set(name, {
      description: current?.description || description || "",
      schema: current?.schema ?? schema,
    })
  }

  captureRequestTools(entries: any[], protocol: Protocol): void {
    for (const entry of entries) {
      const name = toolName(entry)
      if (!name || isLoadToolName(name) || !isFunctionToolEntry(entry, protocol)) continue

      const description = toolDescription(entry)
      const schema = toolSchema(entry)
      const builtIn = this.builtIns.get(name)
      if (builtIn) {
        if (schema !== undefined) builtIn.schema = schema
        continue
      }

      const current = this.mcp.get(name)
      this.mcp.set(name, {
        description: current?.description || description || "",
        schema: current?.schema ?? schema,
      })
    }
  }

  resolve(name: string): KnownTool | undefined {
    if (this.builtIns.has(name)) return { name, kind: "built-in" }
    if (this.mcp.has(name)) return { name, kind: "mcp" }

    const folded = new Set([
      ...Array.from(this.builtIns.keys()).filter((known) => known.toLowerCase() === name.toLowerCase()),
      ...Array.from(this.mcp.keys()).filter((known) => known.toLowerCase() === name.toLowerCase()),
    ])
    if (folded.size !== 1) return undefined
    const [resolved] = folded
    return this.builtIns.has(resolved)
      ? { name: resolved, kind: "built-in" }
      : { name: resolved, kind: "mcp" }
  }

  description(name: string): string | undefined {
    return this.builtIns.get(name)?.description || this.mcp.get(name)?.description
  }

  schema(name: string): any {
    return this.builtIns.get(name)?.schema ?? this.mcp.get(name)?.schema
  }

  allNames(): string[] {
    return Array.from(new Set([...this.builtIns.keys(), ...this.mcp.keys()])).sort()
  }

  pointerList(): string {
    return this.allNames()
      .filter((name) => !isLoadToolName(name))
      .map((name) => {
        const description = this.description(name) || ""
        const brief = briefOf(description)
        return brief ? `- ${name} - ${brief}` : `- ${name}`
      })
      .join("\n")
  }

  categories(): { builtIn: string[]; mcp: string[] } {
    return {
      builtIn: Array.from(this.builtIns.keys()).sort(),
      mcp: Array.from(this.mcp.keys()).sort(),
    }
  }
}

export class TurnStore {
  private readonly values = new Map<string, { names: Set<string>; updated: number }>()
  private readonly ttlMs = 10 * 60 * 1000

  private entry(key: string): { names: Set<string>; updated: number } | undefined {
    const value = this.values.get(key)
    if (!value) return undefined
    if (Date.now() - value.updated > this.ttlMs) {
      this.values.delete(key)
      return undefined
    }
    return value
  }

  has(key: string, name: string): boolean {
    return this.entry(key)?.names.has(name) || false
  }

  add(key: string, name: string): void {
    const value = this.entry(key) || { names: new Set<string>(), updated: 0 }
    value.names.add(name)
    value.updated = Date.now()
    this.values.set(key, value)
  }

  clear(key: string): void {
    this.values.delete(key)
  }
}

export function normalizeSchemaValue(value: any, schema: any): any {
  const types = Array.isArray(schema?.type)
    ? schema.type.filter((type: unknown) => type !== "null")
    : [schema?.type]
  if (types.length !== 1) return value

  switch (types[0]) {
    case "number":
    case "integer": {
      if (typeof value !== "string" || value.trim() === "") return value
      const number = Number(value)
      if (!Number.isFinite(number)) return value
      if (types[0] === "integer" && !Number.isSafeInteger(number)) return value
      return number
    }
    case "boolean":
      if (value === "true") return true
      if (value === "false") return false
      return value
    case "array": {
      let array = value
      if (typeof array === "string") {
        try {
          const parsed = JSON.parse(array)
          if (!Array.isArray(parsed)) return value
          array = parsed
        } catch {
          return value
        }
      }
      return Array.isArray(array) && schema.items
        ? array.map((item: any) => normalizeSchemaValue(item, schema.items))
        : array
    }
    case "object": {
      let object = value
      if (typeof object === "string") {
        try {
          const parsed = JSON.parse(object)
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value
          object = parsed
        } catch {
          return value
        }
      }
      if (!object || typeof object !== "object" || Array.isArray(object)) return object
      if (!schema.properties || typeof schema.properties !== "object") return object
      const normalized = { ...object }
      for (const [property, propertySchema] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(normalized, property)) {
          normalized[property] = normalizeSchemaValue(normalized[property], propertySchema)
        }
      }
      return normalized
    }
    default:
      return value
  }
}

function normalizeToolArguments(argumentsJson: string, schema: any): string {
  if (!schema) return argumentsJson
  try {
    return JSON.stringify(normalizeSchemaValue(JSON.parse(argumentsJson), schema))
  } catch {
    return argumentsJson
  }
}

function setDescription(entry: any, description: string): void {
  if (entry?.function) entry.function.description = description
  else entry.description = description
}

function gatewayDescription(registry: ToolRegistry): string {
  const pointers = registry.pointerList()
  return [
    "Gateway tool. Use it to load or execute another tool.",
    "",
    "Available tools:",
    pointers || "(No tool definitions have been observed yet.)",
    "",
    'Load schema: load_tool({name: "toolname"})',
    'Execute: load_tool({name: "toolname", args: {param: value}})',
    "",
    "The real tool is not in the provider tool list. Always use load_tool.",
  ].join("\n")
}

function rewriteToolChoice(choice: any, protocol: Protocol, loadToolName: string): any {
  if (!choice || typeof choice !== "object") return choice
  if (choice.type === "allowed_tools") {
    if (protocol !== "responses") return "auto"
    return {
      ...choice,
      tools: [{ type: "function", name: loadToolName }],
    }
  }
  if (protocol === "anthropic" && choice.type === "tool") {
    return { ...choice, name: loadToolName }
  }
  if (choice.type !== "function") return choice
  if (choice.function && typeof choice.function === "object") {
    return { ...choice, function: { ...choice.function, name: loadToolName } }
  }
  return { ...choice, name: loadToolName }
}

export function transformRequestBody(
  body: any,
  protocol: Protocol,
  registry: ToolRegistry,
): { changed: boolean; loadToolName: string; body: any } {
  if (!body || !Array.isArray(body.tools)) {
    return { changed: false, loadToolName: "load_tool", body }
  }

  const gateway = body.tools.find((entry: any) => isLoadToolName(toolName(entry)))
  if (!gateway) return { changed: false, loadToolName: "load_tool", body }

  registry.captureRequestTools(body.tools, protocol)
  const loadToolName = toolName(gateway)
  const description = gatewayDescription(registry)

  body.tools = body.tools.filter((entry: any) => {
    const name = toolName(entry)
    return !name || !isFunctionToolEntry(entry, protocol) || isLoadToolName(name)
  })
  for (const entry of body.tools) {
    if (isLoadToolName(toolName(entry))) setDescription(entry, description)
  }

  if (body.tool_choice && body.tool_choice !== "none") {
    body.tool_choice = rewriteToolChoice(body.tool_choice, protocol, loadToolName)
  }

  return { changed: true, loadToolName, body }
}

function parsedJson(value: string): any | undefined {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

type RewriteContext = {
  registry: ToolRegistry
  turns: TurnStore
  key: string
  loadToolName: string
}

function rewriteCall(name: string, argumentsJson: string, context: RewriteContext): { name: string; arguments: string } {
  const args = parsedJson(argumentsJson)
  if (isLoadToolName(name)) {
    if (!args || typeof args !== "object") return { name: context.loadToolName, arguments: argumentsJson }

    const requestedName = typeof args.name === "string" ? args.name : ""
    const known = context.registry.resolve(requestedName)
    const resolvedName = known?.name || requestedName
    if (resolvedName && Object.prototype.hasOwnProperty.call(args, "args") && args.args != null) {
      if (known) context.turns.add(context.key, known.name)
      const realArguments = typeof args.args === "string" ? args.args : JSON.stringify(args.args)
      return {
        name: known?.name || resolvedName,
        arguments: normalizeToolArguments(realArguments, context.registry.schema(known?.name || resolvedName)),
      }
    }

    if (known) context.turns.add(context.key, known.name)
    return {
      name: context.loadToolName,
      arguments: resolvedName && resolvedName !== requestedName
        ? JSON.stringify({ ...args, name: resolvedName })
        : argumentsJson,
    }
  }

  const known = context.registry.resolve(name)
  if (!known || !context.turns.has(context.key, known.name)) {
    if (known) context.turns.add(context.key, known.name)
    return {
      name: context.loadToolName,
      arguments: JSON.stringify({ name: known?.name || name }),
    }
  }

  return {
    name: known.name,
    arguments: normalizeToolArguments(argumentsJson, context.registry.schema(known.name)),
  }
}

function makeChatCall(index: number, id: string | undefined, call: { name: string; arguments: string }): any {
  return {
    index,
    ...(id ? { id } : {}),
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }
}

type ChatPending = {
  id?: string
  name: string
  arguments: string
}

function createChatProcessor(context: RewriteContext) {
  const pending = new Map<number, ChatPending>()
  let implicitIndex = 0

  function rewritePending(index: number, item: ChatPending): any {
    const call = rewriteCall(item.name, item.arguments, context)
    return makeChatCall(index, item.id, call)
  }

  function flushPending(): any[] {
    const calls: any[] = []
    for (const [index, item] of pending) {
      calls.push(rewritePending(index, {
        ...item,
        arguments: item.arguments || "{}",
      }))
    }
    pending.clear()
    return calls
  }

  return {
    process(value: any): any[] | null {
      const choice = value?.choices?.[0]
      const delta = choice?.delta
      const incoming = delta?.tool_calls
      const finishReason = choice?.finish_reason

      if (!Array.isArray(incoming)) {
        if (finishReason && pending.size > 0 && delta) {
          const complete = flushPending()
          if (finishReason === "stop") context.turns.clear(context.key)
          if (complete.length > 0) {
            delta.tool_calls = complete
            return [value]
          }
        }
        if (finishReason && finishReason !== "tool_calls" && finishReason !== "function_call") {
          context.turns.clear(context.key)
        }
        return null
      }

      const complete: any[] = []
      for (const raw of incoming) {
        if (!raw || typeof raw !== "object") continue
        const index = typeof raw.index === "number" ? raw.index : implicitIndex++
        const current = pending.get(index) || { id: undefined, name: "", arguments: "" }
        if (raw.id) current.id = raw.id
        if (raw.function?.name) current.name = raw.function.name
        if (typeof raw.function?.arguments === "string") current.arguments += raw.function.arguments
        pending.set(index, current)

        if (current.name && parsedJson(current.arguments) !== undefined) {
          pending.delete(index)
          complete.push(rewritePending(index, current))
        }
      }

      if (finishReason && pending.size > 0) complete.push(...flushPending())
      if (finishReason && finishReason !== "tool_calls" && finishReason !== "function_call") {
        context.turns.clear(context.key)
      }

      if (complete.length === 0) {
        delete delta.tool_calls
        return Object.keys(delta).length > 0 ? [value] : []
      }
      delta.tool_calls = complete
      return [value]
    },
    flush(): any[] {
      return flushPending()
    },
  }
}

type ResponsesPending = {
  added?: any
  name: string
  arguments: string
}

function createResponsesProcessor(context: RewriteContext) {
  const pending = new Map<number, ResponsesPending>()
  const rewritten = new Map<number, { name: string; arguments: string }>()
  let sawFunctionCall = false

  function finish(index: number, item: any, originalDone: any): any[] {
    const current: ResponsesPending = pending.get(index) || { name: item?.name || "", arguments: "" }
    pending.delete(index)
    const finalItem = { ...item }
    if (typeof finalItem.name === "string") current.name = finalItem.name
    if (typeof finalItem.arguments === "string") current.arguments = finalItem.arguments
    finalItem.name = current.name
    finalItem.arguments = current.arguments || "{}"
    if (finalItem.status === undefined) finalItem.status = "completed"

    const call = rewriteCall(current.name, current.arguments || "{}", context)
    const rewrittenItem = { ...finalItem, name: call.name, arguments: call.arguments }
    rewritten.set(index, call)
    const addedItem = { ...rewrittenItem, arguments: "" }
    const added = {
      ...(current.added || originalDone),
      type: "response.output_item.added",
      output_index: index,
      item: addedItem,
    }
    const delta: any = {
      type: "response.function_call_arguments.delta",
      item_id: rewrittenItem.id,
      output_index: index,
      delta: call.arguments,
    }
    if (originalDone.response_id) delta.response_id = originalDone.response_id
    const argumentsDone: any = {
      type: "response.function_call_arguments.done",
      item_id: rewrittenItem.id,
      output_index: index,
      arguments: call.arguments,
    }
    if (originalDone.response_id) argumentsDone.response_id = originalDone.response_id
    const done = { ...originalDone, type: "response.output_item.done", item: rewrittenItem }
    return [added, delta, argumentsDone, done]
  }

  function flushPending(): any[] {
    const output: any[] = []
    for (const [index, current] of pending) {
      if (!current.name) continue
      const item = {
        ...(current.added?.item || {}),
        type: "function_call",
        id: current.added?.item?.id || `lazy_${index}`,
        call_id: current.added?.item?.call_id || `lazy_call_${index}`,
        name: current.name,
        arguments: current.arguments || "{}",
        status: "completed",
      }
      output.push(...finish(index, item, {
        type: "response.output_item.done",
        output_index: index,
      }))
    }
    return output
  }

  return {
    process(value: any): any[] | null {
      switch (value?.type) {
        case "response.output_item.added": {
          if (value.item?.type !== "function_call") return null
          sawFunctionCall = true
          const index = value.output_index
          pending.set(index, {
            added: value,
            name: value.item.name || "",
            arguments: value.item.arguments || "",
          })
          return []
        }
        case "response.function_call_arguments.delta": {
          const current = pending.get(value.output_index) || { name: "", arguments: "" }
          current.arguments += value.delta || ""
          pending.set(value.output_index, current)
          return []
        }
        case "response.function_call_arguments.done": {
          const current = pending.get(value.output_index) || { name: "", arguments: "" }
          if (typeof value.arguments === "string") current.arguments = value.arguments
          pending.set(value.output_index, current)
          return []
        }
        case "response.output_item.done": {
          if (value.item?.type !== "function_call") return null
          sawFunctionCall = true
          return finish(value.output_index, value.item, value)
        }
        case "response.completed": {
          const output = Array.isArray(value.response?.output) ? value.response.output : []
          for (const [index, item] of output.entries()) {
            if (item?.type !== "function_call") continue
            sawFunctionCall = true
            const current = pending.get(index)
            if (current) {
              current.name = item.name || current.name
              current.arguments = item.arguments || current.arguments
            } else if (!rewritten.has(index)) {
              pending.set(index, {
                name: item.name || "",
                arguments: item.arguments || "{}",
              })
            }
          }
          const flushed = flushPending()
          const rewrittenOutput = output.map((item: any, index: number) => {
            const call = rewritten.get(index)
            return call && item?.type === "function_call"
              ? { ...item, name: call.name, arguments: call.arguments }
              : item
          })
          const completed = {
            ...value,
            response: { ...value.response, output: rewrittenOutput },
          }
          if (flushed.length > 0) return [...flushed, completed]
          if (!sawFunctionCall) context.turns.clear(context.key)
          return [completed]
        }
        case "response.failed":
        case "response.incomplete":
          context.turns.clear(context.key)
          return null
        default:
          return null
      }
    },
    flush(): any[] {
      return flushPending()
    },
  }
}

type AnthropicPending = {
  start: any
  name: string
  arguments: string
}

function createAnthropicProcessor(context: RewriteContext) {
  const pending = new Map<number, AnthropicPending>()
  let sawToolUse = false

  return {
    process(value: any): any[] | null {
      switch (value?.type) {
        case "content_block_start":
          if (value.content_block?.type !== "tool_use") return null
          sawToolUse = true
          pending.set(value.index, {
            start: value,
            name: value.content_block.name || "",
            arguments: value.content_block.input && Object.keys(value.content_block.input).length > 0
              ? JSON.stringify(value.content_block.input)
              : "",
          })
          return []
        case "content_block_delta":
          if (value.delta?.type !== "input_json_delta") return null
          {
            const current = pending.get(value.index)
            if (!current) return null
            current.arguments += value.delta.partial_json || ""
            return []
          }
        case "content_block_stop":
          {
            const current = pending.get(value.index)
            if (!current) return null
            pending.delete(value.index)
            const call = rewriteCall(current.name, current.arguments || "{}", context)
            const start = {
              ...current.start,
              content_block: {
                ...current.start.content_block,
                name: call.name,
                input: {},
              },
            }
            const delta = {
              type: "content_block_delta",
              index: value.index,
              delta: { type: "input_json_delta", partial_json: call.arguments },
            }
            return [start, delta, value]
          }
        case "message_delta":
          if (value.delta?.stop_reason && value.delta.stop_reason !== "tool_use") {
            context.turns.clear(context.key)
          }
          return null
        case "message_start": {
          const content = value.message?.content
          if (!Array.isArray(content)) return null
          let changed = false
          value.message.content = content.map((block: any) => {
            if (block?.type !== "tool_use") return block
            sawToolUse = true
            changed = true
            const call = rewriteCall(block.name || "", JSON.stringify(block.input ?? {}), context)
            let input: any = {}
            try { input = JSON.parse(call.arguments) } catch {}
            return { ...block, name: call.name, input }
          })
          return changed ? [value] : null
        }
        default:
          return null
      }
    },
    flush(): any[] {
      return []
    },
  }
}

function createProcessor(protocol: Protocol, context: RewriteContext) {
  if (protocol === "responses") return createResponsesProcessor(context)
  if (protocol === "anthropic") return createAnthropicProcessor(context)
  return createChatProcessor(context)
}

function eventSeparatorIndex(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf("\n\n")
  const crlf = value.indexOf("\r\n\r\n")
  if (lf < 0 && crlf < 0) return undefined
  if (lf < 0) return { index: crlf, length: 4 }
  if (crlf < 0) return { index: lf, length: 2 }
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 }
}

function eventData(event: string): string | undefined {
  const lines = event.split(/\r?\n/)
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)))
  return data.length > 0 ? data.join("\n") : undefined
}

function render(value: any): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

export class SseTransformer {
  private buffer = ""
  private readonly processor: ReturnType<typeof createProcessor>

  constructor(
    protocol: Protocol,
    registry: ToolRegistry,
    turns: TurnStore,
    key: string,
    loadToolName: string,
  ) {
    this.processor = createProcessor(protocol, { registry, turns, key, loadToolName })
  }

  push(chunk: string): string {
    this.buffer += chunk
    let output = ""
    while (true) {
      const separator = eventSeparatorIndex(this.buffer)
      if (!separator) break
      const event = this.buffer.slice(0, separator.index)
      this.buffer = this.buffer.slice(separator.index + separator.length)
      output += this.processEvent(event)
    }
    return output
  }

  finish(): string {
    let output = ""
    if (this.buffer) {
      output += this.processEvent(this.buffer)
      this.buffer = ""
    }
    for (const value of this.processor.flush()) output += render(value)
    return output
  }

  private processEvent(event: string): string {
    const data = eventData(event)
    if (data === undefined) return `${event}\n\n`
    if (data === "[DONE]") {
      const flushed = this.processor.flush().map((item) => render(item)).join("")
      return flushed + `${event}\n\n`
    }

    let value: any
    try {
      value = JSON.parse(data)
    } catch {
      return `${event}\n\n`
    }

    const result = this.processor.process(value)
    if (result === null) return `${event}\n\n`
    return result.map((item) => render(item)).join("")
  }
}

export function transformSseText(
  text: string,
  protocol: Protocol,
  registry: ToolRegistry,
  turns: TurnStore,
  key: string,
  loadToolName = "load_tool",
): string {
  const transformer = new SseTransformer(protocol, registry, turns, key, loadToolName)
  return transformer.push(text) + transformer.finish()
}

export function transformJsonResponseText(
  text: string,
  protocol: Protocol,
  registry: ToolRegistry,
  turns: TurnStore,
  key: string,
  loadToolName = "load_tool",
): string {
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    return text
  }

  const context: RewriteContext = { registry, turns, key, loadToolName }
  if (protocol === "chat") {
    const message = body?.choices?.[0]?.message
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      message.tool_calls = message.tool_calls.map((raw: any) => {
        const name = raw?.function?.name || ""
        const argumentsJson = typeof raw?.function?.arguments === "string"
          ? raw.function.arguments
          : JSON.stringify(raw?.function?.arguments ?? {})
        const call = rewriteCall(name, argumentsJson, context)
        return { ...raw, function: { ...raw.function, name: call.name, arguments: call.arguments } }
      })
    } else {
      turns.clear(key)
    }
  } else if (protocol === "responses") {
    const output = Array.isArray(body?.output) ? body.output : []
    let sawFunctionCall = false
    body.output = output.map((item: any) => {
      if (item?.type !== "function_call") return item
      sawFunctionCall = true
      const call = rewriteCall(item.name || "", item.arguments || "{}", context)
      return { ...item, name: call.name, arguments: call.arguments }
    })
    if (!sawFunctionCall) turns.clear(key)
  } else {
    const content = Array.isArray(body?.content) ? body.content : []
    let sawToolUse = false
    body.content = content.map((block: any) => {
      if (block?.type !== "tool_use") return block
      sawToolUse = true
      const call = rewriteCall(block.name || "", JSON.stringify(block.input ?? {}), context)
      let input: any = {}
      try { input = JSON.parse(call.arguments) } catch {}
      return { ...block, name: call.name, input }
    })
    if (!sawToolUse || body.stop_reason !== "tool_use") turns.clear(key)
  }

  return JSON.stringify(body)
}

export function createSseTransform(
  protocol: Protocol,
  registry: ToolRegistry,
  turns: TurnStore,
  key: string,
  loadToolName = "load_tool",
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const transformer = new SseTransformer(protocol, registry, turns, key, loadToolName)
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const output = transformer.push(decoder.decode(chunk, { stream: true }))
      if (output) controller.enqueue(encoder.encode(output))
    },
    flush(controller) {
      const tail = decoder.decode()
      const output = transformer.push(tail) + transformer.finish()
      if (output) controller.enqueue(encoder.encode(output))
    },
  })
}

export function protocolForUrl(url: string): Protocol | undefined {
  if (url.includes("/responses")) return "responses"
  if (url.includes("/chat/completions")) return "chat"
  if (
    url.includes("/v1/messages") ||
    (url.includes("/messages") && url.includes("anthropic")) ||
    url.includes("/publishers/anthropic/") &&
      (url.includes(":streamRawPredict") || url.includes(":rawPredict"))
  ) {
    return "anthropic"
  }
  return undefined
}

function headersFrom(init: RequestInit | undefined): Headers {
  try {
    return new Headers(init?.headers)
  } catch {
    return new Headers()
  }
}

function lastUserInput(body: any, protocol: Protocol): any {
  if (protocol === "chat" && Array.isArray(body?.messages)) {
    return body.messages.find((item: any) => item?.role === "user")
  }
  if (protocol === "responses") {
    if (Array.isArray(body?.input)) return body.input.find((item: any) => item?.role === "user") || body.input
    return body?.input
  }
  if (Array.isArray(body?.messages)) return body.messages.find((item: any) => item?.role === "user")
  return body?.input
}

export function sessionKey(
  init: RequestInit | undefined,
  body: any,
  protocol: Protocol,
  directory: string,
): string {
  const headers = headersFrom(init)
  const explicit = headers.get("x-opencode-session") || headers.get("x-session-id") || headers.get("x-session")
  if (explicit) return `session:${explicit}`

  const metadata = body?.metadata?.sessionId || body?.metadata?.session_id || body?.session_id
  if (typeof metadata === "string" && metadata) return `session:${metadata}`

  let fingerprint = ""
  try {
    fingerprint = JSON.stringify(lastUserInput(body, protocol))
  } catch {
    fingerprint = ""
  }
  return `turn:${directory}:${protocol}:${fingerprint.slice(0, 4000)}`
}

export async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (!body) return ""
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (body instanceof Blob) return body.text()
  return ""
}
