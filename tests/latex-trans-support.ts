// Shared helpers for the LaTeXTransKit parity tests; they mirror scripts/latex-trans-parity.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect } from 'vitest'
import type { LaTeXPromptCompleting, LaTeXPromptRequest, TranslationCheckpointStoring } from '../LaTeXTransKit/src'
import { decodeUTF8, parseJSON } from '../LaTeXTransKit/src/json'

export type Entry = Record<string, any>

/** Every regular file: UTF-8 TeX, style and class files verbatim, everything else by hash. */
export function tree(directory: string): Entry {
  const files: Entry = {}
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        const relativePath = relative(directory, path).split(sep).join('/').normalize('NFC')
        const data = new Uint8Array(readFileSync(path))
        const text = /\.(?:tex|sty|cls)$/.test(relativePath) ? decodeUTF8(data) : undefined
        files[relativePath] = text !== undefined ? { text } : { sha256: createHash('sha256').update(data).digest('hex'), size: data.length }
      }
    }
  }
  visit(directory)
  return files
}

/** Compact JSON with sorted keys and unescaped slashes, as the generator's `JSONEncoder` writes it. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export const digest = (value: unknown): string => createHash('sha256').update(canonicalJSON(value)).digest('hex')

export function recordedRequest(request: LaTeXPromptRequest): Entry {
  return { purpose: request.purpose, messages: request.messages, temperature: request.temperature, maximumOutputTokens: request.maximumOutputTokens }
}

/** Answers each request with the recorded answer after checking that the request matches. */
export class ReplayClient implements LaTeXPromptCompleting {
  private index = 0
  constructor(private readonly calls: Entry[]) {}

  async complete(request: LaTeXPromptRequest): Promise<string> {
    const call = this.calls[this.index]
    expect(call, `unexpected model call ${this.index}`).toBeDefined()
    expect(recordedRequest(request)).toEqual({ purpose: call.purpose, messages: call.messages, temperature: call.temperature, maximumOutputTokens: call.maximumOutputTokens })
    this.index += 1
    return call.response
  }

  finish(): void {
    expect(this.index).toBe(this.calls.length)
  }
}

export class RecordingCheckpoints implements TranslationCheckpointStoring {
  readonly operations: Entry[] = []
  readonly store: Map<string, string>
  constructor(initial: Record<string, string> = {}) {
    this.store = new Map(Object.entries(initial))
  }

  async translation(unitID: string, fingerprint: string): Promise<string | undefined> {
    this.operations.push({ op: 'get', unitID, fingerprint })
    return this.store.get(`${unitID}\u001f${fingerprint}`)
  }

  async saveTranslation(translation: string, unitID: string, fingerprint: string): Promise<void> {
    this.operations.push({ op: 'save', unitID, fingerprint, translation })
    this.store.set(`${unitID}\u001f${fingerprint}`, translation)
  }
}

// MARK: The generator's scripted model

const strategyPlans = [
  ['translate'],
  ['garbage', 'translate'],
  ['partial', 'partial', 'partial'],
  ['echo', 'echo', 'echo'],
  ['unsafe', 'fenced', 'translate'],
  ['duplicate', 'whitespace'],
  ['empty', 'translate'],
  ['nonstring', 'trailing'],
  ['firstwins'],
  ['prompt-echo', 'garbage', 'partial']
]

export function planByHash(unitID: string, count: number): string {
  let hash = 0
  for (const byte of new TextEncoder().encode(unitID)) hash = (hash * 31 + byte) & 0xffff
  const plan = strategyPlans[hash % strategyPlans.length]
  return plan[Math.min(count, plan.length - 1)]
}

function slots(request: LaTeXPromptRequest): Array<{ id: string; source: string }> {
  const user = request.messages[request.messages.length - 1]?.content ?? ''
  const marker = '[Translation slots JSON]\n'
  const start = user.indexOf(marker)
  if (start < 0) return []
  const line = user.slice(start + marker.length).split('\n')[0]
  const value = parseJSON(line)
  return Array.isArray(value) ? value as Array<{ id: string; source: string }> : []
}

const encodeAnswer = (pairs: Array<[string, string]>): string => canonicalJSON(pairs.map(([id, translation]) => ({ id, translation })))

function answer(strategy: string, request: LaTeXPromptRequest): string {
  const items = slots(request)
  const translated = items.map((slot): [string, string] => [slot.id, `译${slot.source}`])
  switch (strategy) {
    case 'translate': return encodeAnswer(translated)
    case 'garbage': return 'I cannot help with that request.'
    case 'partial': return encodeAnswer(translated.slice(0, -1))
    case 'echo': return encodeAnswer(items.map((slot) => [slot.id, slot.source]))
    case 'unsafe': return encodeAnswer(translated.map(([id, text], index) => [id, index === 0 ? '\\textbf{坏}' : index === 1 ? '$x$' : text]))
    case 'fenced': return `Here you go:\n\`\`\`json\n${encodeAnswer(translated)}\n\`\`\`\nDone.`
    case 'duplicate': return encodeAnswer([...translated, ...translated.slice(0, 1).map(([id]): [string, string] => [id, '重复'])])
    case 'whitespace': return encodeAnswer(translated.map(([id, text]) => [id, `  \n${text}\t `]))
    case 'empty': return ''
    case 'nonstring': return '[{"id": 1, "translation": "x"}]'
    case 'trailing': return `[${translated.map(([id, text]) => `{"id":"${id}","translation":"${text}"}`).join(',')},]`
    case 'firstwins': return `[${translated.map(([id, text]) => `{"id":"${id}","translation":"${text}","translation":"后"}`).join(',')}]`
    case 'prompt-echo': return request.messages[request.messages.length - 1]?.content ?? ''
    default: throw new Error(`unknown strategy ${strategy}`)
  }
}

/** The generator's `ScriptedClient`: answers by strategy and records every call. */
export class ScriptedClient implements LaTeXPromptCompleting {
  readonly calls: Entry[] = []
  private readonly counts = new Map<string, number>()
  constructor(private readonly summary = 'The paper studies structured translation of LaTeX sources.') {}

  async complete(request: LaTeXPromptRequest): Promise<string> {
    let response: string
    if (request.purpose.kind === 'translation') {
      const count = this.counts.get(request.purpose.unitID) ?? 0
      this.counts.set(request.purpose.unitID, count + 1)
      response = answer(planByHash(request.purpose.unitID, count), request)
    } else {
      response = this.summary
    }
    this.calls.push({ ...recordedRequest(request), response })
    return response
  }
}
