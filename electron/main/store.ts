import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type {
  AppSettings,
  Attachment,
  Folder,
  FolderMembership,
  ItemTypeAssignment,
  LLMAPIStyle,
  ModelProfile,
  Note,
  NoteSelectionContext,
  Paper,
  ProviderProfile,
  ReadingState
} from '../../shared/types'
import { defaultDigestTemplate } from '../../shared/digest'
import { atomicWriteFile } from './files'

export const schemaVersion = 3

type StoredProvider = Omit<ProviderProfile, 'apiKeyConfigured' | 'isBuiltIn'>

export interface Database {
  schemaVersion: number
  papers: Paper[]
  attachments: Attachment[]
  notes: Note[]
  folders: Folder[]
  memberships: FolderMembership[]
  itemTypeAssignments: ItemTypeAssignment[]
  readingStates: ReadingState[]
  providers: StoredProvider[]
  models: ModelProfile[]
  /** Built-in provider and model profiles the user deleted, so they are not seeded again. */
  deletedBuiltInIds: string[]
  settings: AppSettings
}

export interface BuiltInProvider {
  id: string
  name: string
  baseURL: string
  testModel: string
  apiStyle: LLMAPIStyle
  apiKeyPageURL: string
  model: { id: string; name: string; modelName: string; thinkingMode?: 'enabled' | 'disabled' }
}

// The same identifiers as native Freddie, so profiles line up between the two apps.
export const builtInProviders: BuiltInProvider[] = [
  {
    id: '1c613f2b-6209-4e63-b9e1-9dfb415b6cd3',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    testModel: 'gpt-5.6-terra',
    apiStyle: 'responses',
    apiKeyPageURL: 'https://platform.openai.com/api-keys',
    model: { id: '5b97c710-ab92-48a1-93cb-f31bdf4c79a1', name: 'OpenAI GPT-5.6 Terra', modelName: 'gpt-5.6-terra', thinkingMode: 'disabled' }
  },
  {
    id: '71c0bb1c-d797-431f-8bd0-96e0a8c579b5',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    testModel: 'deepseek-v4-flash',
    apiStyle: 'responses',
    apiKeyPageURL: 'https://platform.deepseek.com/api_keys',
    model: { id: '6d6e7dc3-ff41-456a-b04d-30b943130968', name: 'DeepSeek V4 Flash', modelName: 'deepseek-v4-flash', thinkingMode: 'disabled' }
  },
  {
    id: 'e92e2d96-5184-4522-8fb5-df1fc53621ac',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    testModel: 'claude-opus-5-5',
    apiStyle: 'anthropic-messages',
    apiKeyPageURL: 'https://console.anthropic.com/settings/keys',
    model: { id: '6fceac56-f86c-4300-915a-45029950510f', name: 'Claude Opus 5.5', modelName: 'claude-opus-5-5' }
  }
]

export const defaultBabelDocArguments = [
  '--openai',
  '--openai-model', '{model}',
  '--openai-base-url', '{baseUrl}',
  '--openai-api-key', '{apiKey}',
  '--files', '{input}',
  '--output', '{outputDir}',
  '--lang-out', '{lang}',
  '--qps', '{qps}',
  '--pages', '{pages}',
  '--no-dual',
  '--watermark-output-mode', 'no_watermark'
]

export const defaultSettings = (): AppSettings => ({
  appLanguage: 'system',
  targetLanguage: 'zh-CN',
  htmlTranslationConcurrency: 4,
  babelDocQPS: 4,
  pdfTranslationBatchSize: 10,
  translationGlossary: '',
  useArxivLatexStructure: false,
  htmlFontSize: 17,
  readerAppearance: 'default',
  assistantWebSearch: false,
  inspectorCollapsed: false,
  inspectorMode: 'paper',
  collapsedFolderIds: [],
  digestTemplate: defaultDigestTemplate,
  latexTranslationEnabled: false,
  babelDocCommand: 'babeldoc',
  babelDocArguments: [...defaultBabelDocArguments],
  quickSetupHidden: false,
  translationSetupNoticeHandled: false,
  scannedTranscriptionPaperIds: []
})

const emptyDatabase = (): Database => ({
  schemaVersion,
  papers: [],
  attachments: [],
  notes: [],
  folders: [],
  memberships: [],
  itemTypeAssignments: [],
  readingStates: [],
  providers: [],
  models: [],
  deletedBuiltInIds: [],
  settings: defaultSettings()
})

const now = (): string => new Date().toISOString()

export class NotFoundError extends Error {}

export class FreddieStore {
  readonly root: string
  readonly libraryRoot: string
  readonly writingsRoot: string
  private readonly databasePath: string
  private data: Database = emptyDatabase()
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private batchDepth = 0

  constructor(root: string) {
    this.root = root
    this.libraryRoot = join(root, 'Library')
    this.writingsRoot = join(root, 'Writings')
    this.databasePath = join(root, 'library.json')
  }

  async initialize(): Promise<{ legacyApiKeyProviderId?: string }> {
    await mkdir(this.libraryRoot, { recursive: true })
    let result: { legacyApiKeyProviderId?: string } = {}
    try {
      const decoded = JSON.parse(await readFile(this.databasePath, 'utf8')) as Record<string, unknown>
      const migrated = migrateDatabase(decoded)
      this.data = migrated.database
      result = { legacyApiKeyProviderId: migrated.legacyApiKeyProviderId }
      if (migrated.legacyWritings.length) await this.persistLegacyWritings(migrated.legacyWritings)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.seedBuiltInProfiles()
    await this.persist()
    return result
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get database(): Readonly<Database> {
    return this.data
  }

  clone<T>(value: T): T {
    return structuredClone(value)
  }

  paper(id: string): Paper {
    const paper = this.data.papers.find((item) => item.id === id)
    if (!paper) throw new NotFoundError('Paper not found')
    return paper
  }

  attachment(paperId: string, attachmentId: string): Attachment {
    const attachment = this.data.attachments.find((item) => item.id === attachmentId && item.paperId === paperId)
    if (!attachment) throw new NotFoundError('Attachment not found')
    return attachment
  }

  attachments(paperId: string): Attachment[] {
    return this.data.attachments.filter((item) => item.paperId === paperId)
  }

  notes(paperId: string): Note[] {
    return this.data.notes.filter((item) => item.paperId === paperId).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  }

  // MARK: Papers

  async addPaper(paper: Paper, attachments: Attachment[]): Promise<void> {
    this.data.papers.unshift(paper)
    this.data.attachments.push(...attachments)
    await this.commit()
  }

  async addAttachment(attachment: Attachment): Promise<void> {
    this.data.attachments.push(attachment)
    await this.commit()
  }

  async updateAttachment(paperId: string, attachmentId: string, patch: Partial<Attachment>): Promise<void> {
    Object.assign(this.attachment(paperId, attachmentId), patch, { id: attachmentId, paperId })
    await this.commit()
  }

  async removeAttachment(paperId: string, attachmentId: string): Promise<void> {
    this.data.attachments = this.data.attachments.filter((item) => !(item.id === attachmentId && item.paperId === paperId))
    await this.commit()
  }

  /** `touch` is false for edits that must not reorder the library, such as favoriting. */
  async updatePaper(id: string, patch: Partial<Paper>, touch = true): Promise<void> {
    const paper = this.paper(id)
    Object.assign(paper, patch, { id })
    if (touch) paper.modifiedAt = now()
    await this.commit()
  }

  async deletePaper(id: string): Promise<void> {
    this.paper(id)
    this.data.papers = this.data.papers.filter((item) => item.id !== id)
    this.data.attachments = this.data.attachments.filter((item) => item.paperId !== id)
    this.data.notes = this.data.notes.filter((item) => item.paperId !== id)
    this.data.readingStates = this.data.readingStates.filter((item) => item.paperId !== id)
    this.data.memberships = this.data.memberships.filter((item) => item.paperId !== id)
    this.data.itemTypeAssignments = this.data.itemTypeAssignments.filter((item) => item.paperId !== id)
    if (this.data.settings.lastOpenedPaperId === id) delete this.data.settings.lastOpenedPaperId
    await this.commit()
    await rm(this.paperDirectory(id), { recursive: true, force: true })
  }

  async setItemType(paperId: string, itemType: string | null, detectedType: string): Promise<void> {
    this.data.itemTypeAssignments = this.data.itemTypeAssignments.filter((item) => item.paperId !== paperId)
    if (itemType && itemType !== detectedType) this.data.itemTypeAssignments.push({ paperId, itemType, assignedAt: now() })
    await this.commit()
  }

  // MARK: Folders

  async createFolder(name: string, untitled: string, paperId?: string): Promise<Folder> {
    const trimmed = name.split(/\s+/).filter(Boolean).join(' ')
    const timestamp = now()
    const folder: Folder = { id: randomUUID(), name: trimmed || this.uniqueFolderName(untitled), createdAt: timestamp, modifiedAt: timestamp }
    this.data.folders.push(folder)
    if (paperId) this.setMembership(paperId, folder.id)
    await this.commit()
    return folder
  }

  private uniqueFolderName(base: string): string {
    const names = new Set(this.data.folders.map((folder) => folder.name))
    if (!names.has(base)) return base
    let index = 2
    while (names.has(`${base} ${index}`)) index += 1
    return `${base} ${index}`
  }

  async renameFolder(id: string, name: string): Promise<void> {
    const folder = this.data.folders.find((item) => item.id === id)
    if (!folder) throw new NotFoundError('Folder not found')
    const trimmed = name.split(/\s+/).filter(Boolean).join(' ')
    if (!trimmed || trimmed === folder.name) return
    folder.name = trimmed
    folder.modifiedAt = now()
    await this.commit()
  }

  /** Papers in a deleted folder move to Unfiled; no paper is deleted. */
  async removeFolder(id: string): Promise<void> {
    this.data.folders = this.data.folders.filter((item) => item.id !== id)
    this.data.memberships = this.data.memberships.filter((item) => item.folderId !== id)
    this.data.settings.collapsedFolderIds = this.data.settings.collapsedFolderIds.filter((item) => item !== id)
    await this.commit()
  }

  async movePaper(paperId: string, folderId: string | null): Promise<void> {
    this.paper(paperId)
    if (folderId && !this.data.folders.some((folder) => folder.id === folderId)) throw new NotFoundError('Folder not found')
    if (folderId) this.setMembership(paperId, folderId)
    else this.data.memberships = this.data.memberships.filter((item) => item.paperId !== paperId)
    await this.commit()
  }

  private setMembership(paperId: string, folderId: string): void {
    this.data.memberships = this.data.memberships.filter((item) => item.paperId !== paperId)
    this.data.memberships.push({ paperId, folderId, addedAt: now() })
  }

  // MARK: Notes

  async createNote(paperId: string, selection?: NoteSelectionContext, body = ''): Promise<Note> {
    this.paper(paperId)
    const timestamp = now()
    const note: Note = {
      id: randomUUID(),
      paperId,
      attachmentId: selection?.attachmentId,
      quote: selection?.quote.trim() ?? '',
      body,
      pageIndex: selection?.pageIndex,
      htmlSelector: selection?.htmlSelector,
      createdAt: timestamp,
      modifiedAt: timestamp
    }
    this.data.notes.push(note)
    await this.commit()
    return structuredClone(note)
  }

  async updateNote(id: string, body: string): Promise<void> {
    const note = this.data.notes.find((item) => item.id === id)
    if (!note) throw new NotFoundError('Note not found')
    if (note.body === body) return
    note.body = body
    note.modifiedAt = now()
    await this.commit()
  }

  async removeNote(id: string): Promise<void> {
    this.data.notes = this.data.notes.filter((item) => item.id !== id)
    await this.commit()
  }

  // MARK: Reading state and settings

  async saveReadingState(state: Omit<ReadingState, 'modifiedAt'>): Promise<void> {
    this.paper(state.paperId)
    const next: ReadingState = { ...state, scrollRatio: Math.round(Math.min(Math.max(state.scrollRatio, 0), 1) * 1000) / 1000, modifiedAt: now() }
    const index = this.data.readingStates.findIndex((item) => item.paperId === state.paperId)
    if (index >= 0) this.data.readingStates[index] = next
    else this.data.readingStates.push(next)
    await this.commit(false)
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    this.data.settings = { ...this.data.settings, ...structuredClone(patch) }
    await this.commit()
  }

  // MARK: Providers and models

  storedProvider(id: string): StoredProvider {
    const provider = this.data.providers.find((item) => item.id === id)
    if (!provider) throw new NotFoundError('Provider not found')
    return provider
  }

  model(id: string): ModelProfile {
    const model = this.data.models.find((item) => item.id === id)
    if (!model) throw new NotFoundError('Model not found')
    return model
  }

  async saveProvider(input: Omit<StoredProvider, 'id' | 'createdAt' | 'modifiedAt'> & { id?: string }): Promise<StoredProvider> {
    const timestamp = now()
    const existing = input.id ? this.data.providers.find((item) => item.id === input.id) : undefined
    if (existing) {
      Object.assign(existing, input, { modifiedAt: timestamp })
      await this.commit()
      return structuredClone(existing)
    }
    const provider: StoredProvider = { ...input, id: input.id ?? randomUUID(), createdAt: timestamp, modifiedAt: timestamp }
    this.data.providers.push(provider)
    await this.commit()
    return structuredClone(provider)
  }

  async deleteProvider(id: string): Promise<void> {
    const removedModels = new Set(this.data.models.filter((model) => model.providerId === id).map((model) => model.id))
    this.data.providers = this.data.providers.filter((item) => item.id !== id)
    this.data.models = this.data.models.filter((model) => model.providerId !== id)
    this.clearRoutes(removedModels)
    this.rememberDeletedBuiltIn([id, ...removedModels])
    await this.commit()
  }

  async saveModel(input: Omit<ModelProfile, 'id' | 'createdAt' | 'modifiedAt'> & { id?: string }): Promise<ModelProfile> {
    const timestamp = now()
    const existing = input.id ? this.data.models.find((item) => item.id === input.id) : undefined
    if (existing) {
      for (const key of ['temperature', 'topP', 'maxTokens', 'thinkingMode', 'reasoningEffort'] as const) delete existing[key]
      Object.assign(existing, input, { modifiedAt: timestamp })
      await this.commit()
      return structuredClone(existing)
    }
    const model: ModelProfile = { ...input, id: input.id ?? randomUUID(), createdAt: timestamp, modifiedAt: timestamp }
    this.data.models.push(model)
    await this.commit()
    return structuredClone(model)
  }

  async markModelTested(id: string): Promise<void> {
    const model = this.data.models.find((item) => item.id === id)
    if (!model) return
    model.lastTestedAt = now()
    await this.commit()
  }

  async deleteModel(id: string): Promise<void> {
    this.data.models = this.data.models.filter((item) => item.id !== id)
    this.clearRoutes(new Set([id]))
    this.rememberDeletedBuiltIn([id])
    await this.commit()
  }

  private clearRoutes(modelIds: Set<string>): void {
    const settings = this.data.settings
    for (const key of ['htmlModelId', 'pdfModelId', 'scannedPageModelId', 'assistantModelId'] as const) {
      if (settings[key] && modelIds.has(settings[key]!)) delete settings[key]
    }
  }

  private rememberDeletedBuiltIn(ids: Iterable<string>): void {
    const builtInIds = new Set(builtInProviders.flatMap((provider) => [provider.id, provider.model.id]))
    for (const id of ids) if (builtInIds.has(id) && !this.data.deletedBuiltInIds.includes(id)) this.data.deletedBuiltInIds.push(id)
  }

  private seedBuiltInProfiles(): void {
    const timestamp = now()
    for (const descriptor of builtInProviders) {
      if (!this.data.deletedBuiltInIds.includes(descriptor.id) && !this.data.providers.some((item) => item.id === descriptor.id)) {
        this.data.providers.push({
          id: descriptor.id,
          name: descriptor.name,
          baseURL: descriptor.baseURL,
          apiStyle: descriptor.apiStyle,
          testModel: descriptor.testModel,
          isEnabled: true,
          createdAt: timestamp,
          modifiedAt: timestamp
        })
      }
      const providerExists = this.data.providers.some((item) => item.id === descriptor.id)
      if (providerExists && !this.data.deletedBuiltInIds.includes(descriptor.model.id) && !this.data.models.some((item) => item.id === descriptor.model.id)) {
        this.data.models.push({
          id: descriptor.model.id,
          providerId: descriptor.id,
          name: descriptor.model.name,
          modelName: descriptor.model.modelName,
          thinkingMode: descriptor.model.thinkingMode,
          isEnabled: true,
          createdAt: timestamp,
          modifiedAt: timestamp
        })
      }
    }
  }

  // MARK: Files

  paperDirectory(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid paper identifier')
    return join(this.libraryRoot, id)
  }

  async ensurePaperDirectory(id: string): Promise<string> {
    const directory = this.paperDirectory(id)
    await mkdir(directory, { recursive: true })
    return directory
  }

  /** Resolves a path below the paper's directory, refusing anything that escapes it. */
  resolvePaperPath(paperId: string, relativePath: string): string {
    const directory = resolve(this.paperDirectory(paperId))
    const candidate = resolve(directory, relativePath)
    if (!candidate.startsWith(`${directory}${sep}`)) throw new Error('Invalid paper path')
    return candidate
  }

  attachmentPath(paperId: string, attachmentId: string): string {
    return this.resolvePaperPath(paperId, this.attachment(paperId, attachmentId).filename)
  }

  // MARK: Import

  /** Runs many changes with one write at the end, as an import does. */
  async batch<T>(work: () => Promise<T>): Promise<T> {
    this.batchDepth += 1
    try {
      return await work()
    } finally {
      this.batchDepth -= 1
      if (this.batchDepth === 0) await this.commit()
    }
  }

  async importPaper(paper: Paper, attachments: Attachment[]): Promise<void> {
    if (this.data.papers.some((item) => item.id === paper.id)) return
    this.data.papers.push(paper)
    this.data.attachments.push(...attachments)
    await this.commit()
  }

  async importFolder(folder: Folder): Promise<void> {
    if (!this.data.folders.some((item) => item.id === folder.id)) this.data.folders.push(folder)
    await this.commit()
  }

  async importNote(note: Note): Promise<void> {
    if (!this.data.notes.some((item) => item.id === note.id)) this.data.notes.push(note)
    await this.commit()
  }

  async importTranslationCache(paperId: string, entries: unknown[]): Promise<void> {
    await atomicWriteFile(join(this.paperDirectory(paperId), 'translations', 'html-cache.json'), `${JSON.stringify({ version: 1, entries })}\n`)
  }

  // MARK: Persistence

  private async commit(notify = true): Promise<void> {
    if (this.batchDepth > 0) return
    await this.persist()
    if (notify) for (const listener of this.listeners) listener()
  }

  private persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.data, null, 2)}\n`
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.databasePath), { recursive: true })
        await atomicWriteFile(this.databasePath, serialized)
      })
    return this.writeQueue
  }

  private async persistLegacyWritings(writings: Array<{ id: string; markdown: string; createdAt: string; modifiedAt: string }>): Promise<void> {
    const { WritingStore } = await import('./writings')
    const store = new WritingStore(this.writingsRoot)
    for (const writing of writings) await store.save(writing.id, writing.markdown, writing.createdAt, new Date(writing.modifiedAt))
  }
}

// MARK: Migration

interface LegacyPaperV2 {
  id: string
  title?: string
  authors?: string[]
  abstract?: string
  publishedAt?: string
  createdAt?: string
  modifiedAt?: string
  source?: 'local' | 'arxiv' | 'web'
  sourceUrl?: string
  arxivId?: string
  doi?: string
  fileName?: string
  pdfFileName?: string
  htmlFileName?: string
  translatedFileName?: string
  folderId?: string
  favorite?: boolean
  tags?: string[]
}

interface MigrationResult {
  database: Database
  legacyApiKeyProviderId?: string
  legacyWritings: Array<{ id: string; markdown: string; createdAt: string; modifiedAt: string }>
}

/** Brings any earlier schema up to the current one, one version at a time. */
export function migrateDatabase(value: Record<string, unknown>): MigrationResult {
  const version = typeof value.schemaVersion === 'number' ? value.schemaVersion : 1
  if (version > schemaVersion) throw new Error(`library.json was written by a newer Freddie (schema ${version}).`)
  if (version >= 3) return { database: normalizeV3(value as Partial<Database>), legacyWritings: [] }
  return migrateV2(value)
}

function normalizeV3(value: Partial<Database>): Database {
  const base = emptyDatabase()
  return {
    ...base,
    ...value,
    schemaVersion,
    papers: (value.papers ?? []).map((paper) => ({ ...paper, authors: paper.authors ?? [], categories: paper.categories ?? [], tags: paper.tags ?? [], abstract: paper.abstract ?? '' })),
    attachments: value.attachments ?? [],
    notes: value.notes ?? [],
    folders: value.folders ?? [],
    memberships: value.memberships ?? [],
    itemTypeAssignments: value.itemTypeAssignments ?? [],
    readingStates: value.readingStates ?? [],
    providers: value.providers ?? [],
    models: value.models ?? [],
    deletedBuiltInIds: value.deletedBuiltInIds ?? [],
    settings: { ...base.settings, ...value.settings }
  }
}

/** Schema 1 and 2 kept file names on the paper and one provider in settings. */
function migrateV2(value: Record<string, unknown>): MigrationResult {
  const database = emptyDatabase()
  const timestamp = now()
  const papers = (value.papers as LegacyPaperV2[] | undefined) ?? []
  for (const legacy of papers) {
    const createdAt = legacy.createdAt ?? timestamp
    database.papers.push({
      id: legacy.id,
      arxivId: legacy.arxivId,
      doi: legacy.doi,
      title: legacy.title ?? 'Untitled PDF',
      abstract: legacy.abstract ?? '',
      authors: legacy.authors ?? [],
      categories: [],
      publishedAt: legacy.publishedAt,
      htmlUrl: legacy.source === 'web' || legacy.source === 'arxiv' ? legacy.sourceUrl : undefined,
      tags: legacy.tags ?? [],
      isFavorite: legacy.favorite ?? false,
      createdAt,
      modifiedAt: legacy.modifiedAt ?? createdAt
    })
    const sourceFor = (kind: 'pdf' | 'html'): Attachment['source'] =>
      legacy.source === 'arxiv' ? (kind === 'pdf' ? 'arxivPDF' : 'arxivHTML') : legacy.source === 'web' ? 'webPage' : 'localImport'
    const pdf = legacy.pdfFileName ?? (legacy.fileName?.toLowerCase().endsWith('.pdf') ? legacy.fileName : undefined)
    const html = legacy.htmlFileName ?? (legacy.fileName && /\.html?$/i.test(legacy.fileName) ? legacy.fileName : undefined)
    if (pdf) database.attachments.push({ id: randomUUID(), paperId: legacy.id, kind: 'pdf', source: sourceFor('pdf'), filename: pdf, createdAt })
    if (html) database.attachments.push({ id: randomUUID(), paperId: legacy.id, kind: 'html', source: sourceFor('html'), filename: html, createdAt })
    if (legacy.translatedFileName?.toLowerCase().endsWith('.pdf')) {
      database.attachments.push({ id: randomUUID(), paperId: legacy.id, kind: 'translatedPDF', source: 'babeldoc', filename: legacy.translatedFileName, createdAt: timestamp })
    }
    if (legacy.folderId) database.memberships.push({ paperId: legacy.id, folderId: legacy.folderId, addedAt: timestamp })
  }

  for (const folder of (value.folders as Array<{ id: string; name: string; createdAt?: string }> | undefined) ?? []) {
    database.folders.push({ id: folder.id, name: folder.name, createdAt: folder.createdAt ?? timestamp, modifiedAt: folder.createdAt ?? timestamp })
  }
  const folderIds = new Set(database.folders.map((folder) => folder.id))
  database.memberships = database.memberships.filter((membership) => folderIds.has(membership.folderId))

  const paperIds = new Set(database.papers.map((paper) => paper.id))
  for (const note of (value.notes as Array<Partial<Note> & { page?: number; selector?: string }> | undefined) ?? []) {
    if (!note.id || !note.paperId || !paperIds.has(note.paperId)) continue
    database.notes.push({
      id: note.id,
      paperId: note.paperId,
      quote: note.quote ?? '',
      body: note.body ?? '',
      pageIndex: typeof note.page === 'number' ? Math.max(0, note.page - 1) : undefined,
      htmlSelector: note.selector,
      createdAt: note.createdAt ?? timestamp,
      modifiedAt: note.modifiedAt ?? timestamp
    })
  }

  for (const state of (value.readingStates as Array<{ paperId: string; page?: number; scrollRatio?: number; zoom?: number; contentMode?: 'html' | 'pdf'; mode?: string }> | undefined) ?? []) {
    if (!paperIds.has(state.paperId)) continue
    const readerMode = state.contentMode === 'html' ? 'html' : state.mode === 'split' ? 'bilingualPDF' : state.mode === 'translated' ? 'translatedPDF' : 'pdf'
    database.readingStates.push({
      paperId: state.paperId,
      readerMode,
      pageIndex: Math.max(0, (state.page ?? 1) - 1),
      scrollRatio: state.scrollRatio ?? 0,
      zoomScale: state.zoom ?? 1,
      modifiedAt: timestamp
    })
  }

  const legacySettings = (value.settings ?? {}) as {
    language?: string
    theme?: string
    provider?: { baseUrl?: string; model?: string; apiKeyConfigured?: boolean; temperature?: number }
    translation?: { targetLanguage?: string; babeldocCommand?: string; babeldocArgs?: string[] }
  }
  if (legacySettings.language === 'en' || legacySettings.language === 'zh-Hans') database.settings.appLanguage = legacySettings.language
  if (legacySettings.theme === 'paper') database.settings.readerAppearance = 'paper'
  if (legacySettings.translation?.targetLanguage && /english/i.test(legacySettings.translation.targetLanguage)) database.settings.targetLanguage = 'EN'
  if (legacySettings.translation?.babeldocCommand) database.settings.babelDocCommand = legacySettings.translation.babeldocCommand
  if (typeof value.selectedPaperId === 'string' && paperIds.has(value.selectedPaperId)) database.settings.lastOpenedPaperId = value.selectedPaperId

  // The single provider becomes a custom profile; its key is moved to that profile by the caller.
  let legacyApiKeyProviderId: string | undefined
  const legacyProvider = legacySettings.provider
  if (legacyProvider?.baseUrl && legacyProvider.model) {
    const providerId = randomUUID()
    const modelId = randomUUID()
    database.providers.push({
      id: providerId,
      name: new URL(legacyProvider.baseUrl).hostname,
      baseURL: legacyProvider.baseUrl,
      apiStyle: 'chat-completions',
      testModel: legacyProvider.model,
      isEnabled: true,
      createdAt: timestamp,
      modifiedAt: timestamp
    })
    database.models.push({
      id: modelId,
      providerId,
      name: legacyProvider.model,
      modelName: legacyProvider.model,
      temperature: legacyProvider.temperature,
      isEnabled: true,
      createdAt: timestamp,
      modifiedAt: timestamp
    })
    if (legacyProvider.apiKeyConfigured) {
      legacyApiKeyProviderId = providerId
      database.settings.htmlModelId = modelId
      database.settings.pdfModelId = modelId
    }
  }

  const legacyWritings = ((value.writings as Array<{ id: string; title?: string; body?: string; createdAt?: string; modifiedAt?: string }> | undefined) ?? [])
    .map((writing) => ({
      id: writing.id,
      markdown: writing.body ?? (writing.title ? `# ${writing.title}\n` : ''),
      createdAt: writing.createdAt ?? timestamp,
      modifiedAt: writing.modifiedAt ?? timestamp
    }))

  return { database, legacyApiKeyProviderId, legacyWritings }
}
