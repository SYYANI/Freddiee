import type { ChatMessage, LLMAPIStyle, LLMReasoningEffort, LLMThinkingMode, ModelProfile } from '../../shared/types'
import type { Translator } from '../../shared/i18n'
import type { FreddieStore } from './store'
import type { SecretStore } from './secrets'

export interface CompletionRequest {
  baseURL: string
  apiStyle: LLMAPIStyle
  apiKey: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  topP?: number
  maxTokens?: number
  thinkingMode?: LLMThinkingMode
  reasoningEffort?: LLMReasoningEffort
  webSearch?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

export interface WebSearchSource {
  url: string
  title?: string
}

export interface CompletionResponse {
  text: string
  sources: WebSearchSource[]
}

export class LLMError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

export class RouteError extends Error {}

export interface ResolvedRoute {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  baseURL: string
  apiStyle: LLMAPIStyle
  apiKey: string
  temperature?: number
  topP?: number
  maxTokens?: number
  thinkingMode?: LLMThinkingMode
  reasoningEffort?: LLMReasoningEffort
}

export type RouteKind = 'html' | 'pdf' | 'assistant' | 'scanned'

/** Resolves the model chosen for a task to its provider and stored key, as LLMRouteResolver does. */
export async function resolveRoute(kind: RouteKind, store: FreddieStore, secrets: SecretStore, t: Translator): Promise<ResolvedRoute> {
  const settings = store.database.settings
  const selected = kind === 'html'
    ? settings.htmlModelId
    : kind === 'pdf'
      ? settings.pdfModelId
      : kind === 'assistant'
        ? settings.assistantModelId ?? settings.htmlModelId
        : settings.scannedPageModelId ?? settings.pdfModelId
  if (!selected) {
    throw new RouteError(kind === 'html'
      ? t('Choose an HTML translation model in Settings first.')
      : kind === 'assistant'
        ? t('Choose a reading assistant model in Settings first.')
        : t('Choose a PDF translation model in Settings first.'))
  }
  const model = store.database.models.find((item) => item.id === selected)
  if (!model) throw new RouteError(t('The selected translation model could not be found.'))
  if (!model.isEnabled) throw new RouteError(t('The selected model “%@” is disabled.', model.name))
  const provider = store.database.providers.find((item) => item.id === model.providerId)
  if (!provider) throw new RouteError(t('The selected translation provider could not be found.'))
  if (!provider.isEnabled) throw new RouteError(t('The selected provider “%@” is disabled.', provider.name))
  try {
    new URL(provider.baseURL)
  } catch {
    throw new RouteError(t('The provider Base URL is invalid: %@', provider.baseURL))
  }
  const apiKey = (await secrets.key(provider.id))?.trim()
  if (!apiKey) throw new RouteError(t('No API key is saved for provider “%@”.', provider.name))
  return routeFor(provider, model, apiKey)
}

export function routeFor(provider: { id: string; name: string; baseURL: string; apiStyle: LLMAPIStyle }, model: Pick<ModelProfile, 'id' | 'modelName' | 'temperature' | 'topP' | 'maxTokens' | 'thinkingMode' | 'reasoningEffort'>, apiKey: string): ResolvedRoute {
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelName: model.modelName,
    baseURL: provider.baseURL,
    apiStyle: provider.apiStyle,
    apiKey,
    temperature: model.temperature,
    topP: model.topP,
    maxTokens: model.maxTokens,
    thinkingMode: model.thinkingMode,
    reasoningEffort: model.reasoningEffort
  }
}

/** The request for a route; Anthropic models only receive sampling values that were set explicitly. */
export function requestFor(route: ResolvedRoute, messages: ChatMessage[], options: { defaultTemperature?: number; webSearch?: boolean; signal?: AbortSignal; maxTokens?: number } = {}): CompletionRequest {
  return {
    baseURL: route.baseURL,
    apiStyle: route.apiStyle,
    apiKey: route.apiKey,
    model: route.modelName,
    messages,
    temperature: route.temperature ?? (route.apiStyle === 'anthropic-messages' ? undefined : options.defaultTemperature),
    topP: route.topP,
    maxTokens: route.maxTokens ?? options.maxTokens,
    thinkingMode: route.thinkingMode,
    reasoningEffort: route.reasoningEffort,
    webSearch: options.webSearch,
    signal: options.signal
  }
}

function endpoint(baseURL: string, apiStyle: LLMAPIStyle): string {
  const base = baseURL.replace(/\/+$/, '')
  const suffix = apiStyle === 'chat-completions' ? '/chat/completions' : apiStyle === 'responses' ? '/responses' : '/messages'
  return base.endsWith(suffix) ? base : base + suffix
}

function body(request: CompletionRequest, stream: boolean): Record<string, unknown> {
  const { messages } = request
  if (request.apiStyle === 'chat-completions') {
    const result: Record<string, unknown> = { model: request.model, messages, stream }
    if (request.temperature !== undefined) result.temperature = request.temperature
    if (request.topP !== undefined) result.top_p = request.topP
    if (request.maxTokens !== undefined) result.max_tokens = request.maxTokens
    if (request.thinkingMode === 'disabled') result.thinking = { type: 'disabled' }
    else {
      if (request.thinkingMode === 'enabled') result.thinking = { type: 'enabled' }
      if (request.reasoningEffort) result.reasoning_effort = request.reasoningEffort
    }
    return result
  }
  if (request.apiStyle === 'responses') {
    const result: Record<string, unknown> = {
      model: request.model,
      input: messages.map((message) => ({ role: message.role === 'system' ? 'developer' : message.role, content: message.content })),
      stream
    }
    if (request.temperature !== undefined) result.temperature = request.temperature
    if (request.topP !== undefined) result.top_p = request.topP
    if (request.maxTokens !== undefined) result.max_output_tokens = request.maxTokens
    if (request.thinkingMode === 'disabled') result.reasoning = { effort: 'none' }
    else if (request.reasoningEffort) result.reasoning = { effort: request.reasoningEffort }
    if (request.webSearch) {
      result.tools = [{ type: 'web_search' }]
      result.tool_choice = { type: 'web_search' }
    }
    return result
  }
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).filter(Boolean).join('\n\n')
  const result: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? 16_000,
    messages: messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })),
    stream
  }
  if (system) result.system = system
  if (request.temperature !== undefined) result.temperature = request.temperature
  if (request.topP !== undefined) result.top_p = request.topP
  if (request.thinkingMode === 'disabled') result.thinking = { type: 'disabled' }
  else {
    if (request.thinkingMode === 'enabled') result.thinking = { type: 'adaptive' }
    if (request.reasoningEffort) result.output_config = { effort: request.reasoningEffort }
  }
  if (request.webSearch) result.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
  return result
}

function headers(request: CompletionRequest): Record<string, string> {
  if (request.apiStyle === 'anthropic-messages') {
    return { 'content-type': 'application/json', 'x-api-key': request.apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { 'content-type': 'application/json', authorization: `Bearer ${request.apiKey}` }
}

function combinedSignal(request: CompletionRequest): AbortSignal {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 300_000)
  return request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
}

async function send(request: CompletionRequest, stream: boolean): Promise<Response> {
  let response: Response
  try {
    response = await fetch(endpoint(request.baseURL, request.apiStyle), {
      method: 'POST',
      headers: headers(request),
      body: JSON.stringify(body(request, stream)),
      signal: combinedSignal(request)
    })
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason ?? error
    throw new LLMError(error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1200)
    let message = detail
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } | string; message?: string }
      message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message ?? detail
    } catch {
      // Keep the raw body.
    }
    throw new LLMError(`HTTP ${response.status}: ${message}`, response.status)
  }
  return response
}

export async function complete(request: CompletionRequest): Promise<CompletionResponse> {
  const response = await send(request, false)
  const json = await response.json() as Record<string, unknown>
  return parseResponse(request.apiStyle, json)
}

export function parseResponse(apiStyle: LLMAPIStyle, json: Record<string, unknown>): CompletionResponse {
  const sources: WebSearchSource[] = []
  let text = ''
  if (apiStyle === 'chat-completions') {
    const choices = json.choices as Array<{ message?: { content?: string } }> | undefined
    text = choices?.[0]?.message?.content ?? ''
  } else if (apiStyle === 'responses') {
    if (typeof json.output_text === 'string') text = json.output_text
    for (const item of (json.output as Array<{ type?: string; content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }> }> | undefined) ?? []) {
      if (item.type !== 'message') continue
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && !json.output_text) text += part.text ?? ''
        for (const annotation of part.annotations ?? []) {
          if (annotation.type === 'url_citation' && annotation.url) sources.push({ url: annotation.url, title: annotation.title })
        }
      }
    }
  } else {
    for (const block of (json.content as Array<{ type?: string; text?: string; content?: Array<{ type?: string; url?: string; title?: string }> }> | undefined) ?? []) {
      if (block.type === 'text') text += block.text ?? ''
      if (block.type === 'web_search_tool_result') {
        for (const result of Array.isArray(block.content) ? block.content : []) {
          if (result.type === 'web_search_result' && result.url) sources.push({ url: result.url, title: result.title })
        }
      }
    }
  }
  return { text: text.trim(), sources: dedupeSources(sources) }
}

function dedupeSources(sources: WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>()
  return sources.filter((source) => !seen.has(source.url) && Boolean(seen.add(source.url)))
}

/** Streams server-sent events, reporting the accumulated text after each delta. */
export async function completeStreaming(request: CompletionRequest, onText: (text: string) => void): Promise<CompletionResponse> {
  const response = await send(request, true)
  if (!response.body) return complete(request)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  const sources: WebSearchSource[] = []
  let finalJSON: Record<string, unknown> | undefined

  const handle = (data: string): void => {
    if (!data || data === '[DONE]') return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    let delta = ''
    if (request.apiStyle === 'chat-completions') {
      const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined
      delta = choices?.[0]?.delta?.content ?? ''
    } else if (request.apiStyle === 'responses') {
      if (event.type === 'response.output_text.delta') delta = String(event.delta ?? '')
      if (event.type === 'response.output_text.annotation.added') {
        const annotation = event.annotation as { type?: string; url?: string; title?: string } | undefined
        if (annotation?.type === 'url_citation' && annotation.url) sources.push({ url: annotation.url, title: annotation.title })
      }
      if (event.type === 'response.completed') finalJSON = event.response as Record<string, unknown>
      if (event.type === 'error' || event.type === 'response.failed') {
        const error = (event.error ?? (event.response as { error?: unknown } | undefined)?.error) as { message?: string } | undefined
        throw new LLMError(error?.message ?? 'The model stream failed.')
      }
    } else {
      if (event.type === 'content_block_delta') {
        const blockDelta = event.delta as { type?: string; text?: string } | undefined
        if (blockDelta?.type === 'text_delta') delta = blockDelta.text ?? ''
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block as { type?: string; content?: Array<{ type?: string; url?: string; title?: string }> } | undefined
        if (block?.type === 'web_search_tool_result') {
          for (const result of Array.isArray(block.content) ? block.content : []) {
            if (result.type === 'web_search_result' && result.url) sources.push({ url: result.url, title: result.title })
          }
        }
      }
      if (event.type === 'error') throw new LLMError((event.error as { message?: string } | undefined)?.message ?? 'The model stream failed.')
    }
    if (delta) {
      text += delta
      onText(text)
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary: number
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '')
      const data = chunk.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
      handle(data)
    }
  }
  if (buffer.trim()) handle(buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'))
  if (!text && finalJSON) return parseResponse('responses', finalJSON)
  return { text: text.trim(), sources: dedupeSources(sources) }
}
