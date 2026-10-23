import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../../electron/main/files'
import { RebuildError } from './errors'

/** One part of a chat message: text, or a JPEG image sent as a base64 data URL. */
export type RebuildMessagePart = { type: 'text'; text: string } | { type: 'jpeg'; data: Uint8Array }

export interface RebuildMessage {
  role: 'system' | 'user' | 'assistant'
  parts: RebuildMessagePart[]
}

export function textMessage(role: RebuildMessage['role'], text: string): RebuildMessage {
  return { role, parts: [{ type: 'text', text }] }
}

/** The message's text when it has no images. */
export function plainText(message: RebuildMessage): string | undefined {
  let text = ''
  for (const part of message.parts) {
    if (part.type !== 'text') return undefined
    text += part.text
  }
  return text
}

export interface RebuildUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export function emptyUsage(): RebuildUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
}

export function addUsage(a: RebuildUsage, b: RebuildUsage): RebuildUsage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens
  }
}

export interface RebuildCompletionRequest {
  /** What the request is for, such as `typeset-page-0003`; useful for logs. */
  label: string
  messages: RebuildMessage[]
  maxTokens: number
}

export interface RebuildCompletion {
  text: string
  usage: RebuildUsage
  /** `stop`: the model finished; `length`: the output budget ran out; `other`: anything else, such as a content filter. */
  finishReason: 'stop' | 'length' | 'other'
}

/** A chat model the host app connects: a provider endpoint, model and settings. */
export interface RebuildModelClient {
  /**
   * Describes the endpoint, model and settings; part of every checkpoint key, so
   * changing the model invalidates cached answers. Must not contain secrets.
   */
  readonly identity: string
  complete(request: RebuildCompletionRequest): Promise<RebuildCompletion>
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Pretty JSON with sorted keys, as the Swift package writes its files. */
export function sortedJSON(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]))
  }
  return value
}

/**
 * A model client whose raw answers are checkpointed on disk.
 *
 * Local validation fixes (prompt feedback, layout changes) then never re-bill the model,
 * and an interrupted run resumes where it stopped.
 */
export class CheckpointedModel {
  constructor(
    readonly client: RebuildModelClient,
    readonly directory: string | undefined,
    readonly refresh = false,
    readonly initialMaxTokens = 32_768,
    readonly signal?: AbortSignal
  ) {}

  /** One completion; a truncated answer is requested again with twice the output budget. */
  async chat(label: string, messages: RebuildMessage[]): Promise<{ text: string; usage: RebuildUsage }> {
    let usage = emptyUsage()
    let maxTokens = this.initialMaxTokens
    for (;;) {
      this.signal?.throwIfAborted()
      const completion = await this.cachedComplete({ label, messages, maxTokens })
      usage = addUsage(usage, completion.usage)
      // A larger budget changes the key, so a truncated checkpoint is never replayed.
      if (completion.finishReason === 'length' && maxTokens < 131_072) {
        maxTokens *= 2
        continue
      }
      if (completion.finishReason !== 'stop') {
        throw new RebuildError({ kind: 'incompleteModelOutput', label, finishReason: completion.finishReason })
      }
      return { text: completion.text, usage }
    }
  }

  /** The same client asking the model again; its answers replace the saved ones. */
  refreshing(): CheckpointedModel {
    return new CheckpointedModel(this.client, this.directory, true, this.initialMaxTokens, this.signal)
  }

  /** Would the first request of this conversation be answered from a saved answer? */
  async hasCheckpoint(label: string, messages: RebuildMessage[]): Promise<boolean> {
    if (this.refresh || !this.directory) return false
    return access(this.checkpointPath({ label, messages, maxTokens: this.initialMaxTokens }, this.directory)).then(() => true, () => false)
  }

  private checkpointPath(request: RebuildCompletionRequest, directory: string): string {
    return join(directory, `${request.label}-${CheckpointedModel.digest(request, this.client.identity).slice(0, 20)}.json`)
  }

  private async cachedComplete(request: RebuildCompletionRequest): Promise<RebuildCompletion> {
    if (!this.directory) return this.client.complete(request)
    const file = this.checkpointPath(request, this.directory)
    if (!this.refresh) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as Partial<RebuildCompletion>
        if (typeof cached.text === 'string' && cached.usage && ['stop', 'length', 'other'].includes(cached.finishReason ?? '')) {
          return { text: cached.text, usage: { ...emptyUsage(), ...cached.usage }, finishReason: cached.finishReason! }
        }
      } catch {
        // Ask the model.
      }
    }
    const completion = await this.client.complete(request)
    await atomicWriteFile(file, sortedJSON(completion))
    return completion
  }

  static digest(request: RebuildCompletionRequest, identity: string): string {
    const hasher = createHash('sha256')
    const feed = (text: string): void => {
      const data = Buffer.from(text, 'utf8')
      hasher.update(`${data.length}:`)
      hasher.update(data)
    }
    feed(identity)
    feed(String(request.maxTokens))
    for (const message of request.messages) {
      feed(message.role)
      for (const part of message.parts) {
        if (part.type === 'text') {
          feed('text')
          feed(part.text)
        } else {
          feed('jpeg')
          feed(sha256Hex(part.data))
        }
      }
    }
    return hasher.digest('hex')
  }
}
