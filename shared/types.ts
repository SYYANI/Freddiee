// Domain and IPC contracts shared by the main process, preload bridge, and renderer.
// The shapes mirror the native Freddie SwiftData models so both apps describe a
// library the same way.

import type { DocumentOutlineCache, DocumentOutlineSource } from './outline'
import type { SyncAppliedChange, SyncConflictChoice, SyncStatus } from './sync'

export type AttachmentKind = 'pdf' | 'html' | 'translatedPDF' | 'resource'
export type AttachmentSource =
  | 'arxivPDF'
  | 'arxivHTML'
  | 'localImport'
  | 'webPage'
  | 'babeldoc'
  | 'latexTrans'
  | 'scanRebuild'
  | 'generated'

export type ReaderMode = 'html' | 'pdf' | 'bilingualPDF' | 'translatedPDF'
export type TranslationDisplayMode = 'original' | 'bilingual' | 'translated'
export type InspectorMode = 'paper' | 'writing'
export type ReaderAppearance = 'default' | 'paper'
export type AppLanguage = 'system' | 'en' | 'zh-Hans'
export type TargetLanguageCode = 'EN' | 'zh-CN'
export type BabelDocRenderingMode = 'source-preserving' | 'rebuild'

export interface Paper {
  id: string
  arxivId?: string
  arxivVersion?: string
  doi?: string
  title: string
  abstract: string
  authors: string[]
  categories: string[]
  publishedAt?: string
  updatedAt?: string
  pdfUrl?: string
  htmlUrl?: string
  tags: string[]
  isFavorite: boolean
  createdAt: string
  modifiedAt: string
}

/** Inspector presentation only; the original paper abstract remains metadata. */
export type PaperAbstractContent =
  | { kind: 'hidden' }
  | { kind: 'original' | 'summary'; text: string }

export interface Attachment {
  id: string
  paperId: string
  kind: AttachmentKind
  source: AttachmentSource
  /** Path relative to the paper's directory, using forward slashes. */
  filename: string
  /** Last page covered by a partial translated PDF; absent when complete. */
  translatedLastPage?: number
  createdAt: string
}

export interface Note {
  id: string
  paperId: string
  attachmentId?: string
  quote: string
  body: string
  pageIndex?: number
  htmlSelector?: string
  createdAt: string
  modifiedAt: string
}

export interface Folder {
  id: string
  name: string
  parentId?: string
  createdAt: string
  modifiedAt: string
}

export interface FolderMembership {
  paperId: string
  folderId: string
  addedAt: string
}

export interface ItemTypeAssignment {
  paperId: string
  itemType: string
  assignedAt: string
}

export interface ReadingState {
  paperId: string
  attachmentId?: string
  readerMode: ReaderMode
  pageIndex: number
  scrollRatio: number
  zoomScale: number
  /** Native Freddie's HTML reading anchor, kept from sync while the position is unchanged. */
  htmlAnchor?: string
  modifiedAt: string
}

export type LLMAPIStyle = 'chat-completions' | 'responses' | 'anthropic-messages'
export type LLMThinkingMode = 'enabled' | 'disabled'
export type LLMReasoningEffort = 'low' | 'high' | 'max'

export interface ProviderProfile {
  id: string
  name: string
  baseURL: string
  apiStyle: LLMAPIStyle
  testModel: string
  isEnabled: boolean
  /** Derived by the main process; the key itself never reaches the renderer. */
  apiKeyConfigured: boolean
  isBuiltIn: boolean
  createdAt: string
  modifiedAt: string
}

export interface ModelProfile {
  id: string
  providerId: string
  name: string
  modelName: string
  temperature?: number
  topP?: number
  maxTokens?: number
  thinkingMode?: LLMThinkingMode
  reasoningEffort?: LLMReasoningEffort
  isEnabled: boolean
  lastTestedAt?: string
  createdAt: string
  modifiedAt: string
}

export interface AppSettings {
  appLanguage: AppLanguage
  targetLanguage: TargetLanguageCode
  htmlTranslationConcurrency: number
  pdfTranslationBatchSize: number
  /** Empty means every page; otherwise a comma-separated list such as 1-5,8. */
  babelDocPageRange: string
  babelDocRenderingMode: BabelDocRenderingMode
  /** Maximum translation requests started per second. */
  babelDocQPS: number
  babelDocThinkingMode: LLMThinkingMode
  babelDocSemanticHintsEnabled: boolean
  translationGlossary: string
  htmlFontSize: number
  readerAppearance: ReaderAppearance
  /** Shows explicit PDF zoom controls for devices without convenient pinch gestures. */
  showPDFZoomControls: boolean
  /** Uses drag-to-pan on PDF areas that do not contain selectable text. */
  pdfHandToolEnabled: boolean
  /** The system dark-mode state the appearance was last synchronized with. */
  lastSynchronizedSystemDarkMode?: boolean
  htmlModelId?: string
  pdfModelId?: string
  scannedPageModelId?: string
  assistantModelId?: string
  assistantWebSearch: boolean
  /** Shows the optional arXiv LaTeX source translation route in the reader. */
  latexTranslationEnabled: boolean
  inspectorCollapsed: boolean
  inspectorMode: InspectorMode
  lastOpenedPaperId?: string
  collapsedFolderIds: string[]
  digestExportDirectory?: string
  digestTemplate: string
  latexToolchainDirectory?: string
  quickSetupHidden: boolean
  translationSetupNoticeHandled: boolean
  currentWritingId?: string
  scannedTranscriptionPaperIds: string[]
  /** Set after the first scanned PDF translation, so later runs skip the page-image notice. */
  scannedPDFTranslationConfirmed: boolean
}

export interface WritingCitationRecord {
  paperId: string
  attachmentId?: string
  pageIndex?: number
  htmlSelector?: string
  quotePrefix?: string
}

export interface WritingMetadata {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  citedPaperIds: string[]
  wordCount: number
  citations: WritingCitationRecord[]
}

export interface LibrarySnapshot {
  papers: Paper[]
  attachments: Attachment[]
  notes: Note[]
  folders: Folder[]
  memberships: FolderMembership[]
  itemTypeAssignments: ItemTypeAssignment[]
  readingStates: ReadingState[]
  providers: ProviderProfile[]
  models: ModelProfile[]
  settings: AppSettings
  writings: WritingMetadata[]
  /** Papers with cached HTML translations, for the "Has Translation" filter. */
  htmlTranslatedPaperIds: string[]
  /** The last failed load or save of a writing. */
  writingError?: string
  platform: NodeJS.Platform | string
  systemDarkMode: boolean
}

export interface ImportProgress {
  operationId: string
  stepLabel: string
  fraction: number
  title: string
  detail?: string
}

export interface NativeLibraryImportResult {
  papers: number
  notes: number
  writings: number
}

export type NativeLibraryImportEvent =
  | { type: 'started'; progress: ImportProgress }
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'finished'; progress: ImportProgress; result: NativeLibraryImportResult }
  | { type: 'failed'; message: string }

export type ImportRequest =
  | { type: 'arxiv'; value: string; includeHTML: boolean; operationId: string }
  | { type: 'web'; url: string; operationId: string }
  | { type: 'pdf'; paths?: string[]; operationId: string }

export interface NoteSelectionContext {
  attachmentId?: string
  quote: string
  pageIndex?: number
  htmlSelector?: string
  /** Surrounding text, sent to the reading assistant as local context. */
  context?: string
  /** Screen-space anchor for overlays, in CSS pixels relative to the reader. */
  rect?: { x: number; y: number; width: number; height: number }
}

export interface NoteNavigationRequest {
  id: string
  paperId?: string
  attachmentId?: string
  pageIndex?: number
  htmlSelector?: string
  quote?: string
}

export type TranslationKind = 'html' | 'latex' | 'scan' | 'babeldoc' | 'abstract'

export interface BabelDocTranslationDiagnostics {
  semantic_status: 'notProvided' | 'applied' | 'pdfFallback'
  translation_candidates: number
  translation_completed: number
  translation_failed: number
  provider_failures: number
  placeholder_validation_failures: number
  semantic_translation_fallbacks: number
  continuation_groups: number
  semantic_pdf_paragraphs?: number
  semantic_matched_pdf_paragraphs?: number
  semantic_matched_pdf_coverage?: number
  semantic_high_confidence?: number
  semantic_medium_confidence?: number
  semantic_low_confidence?: number
  semantic_structural_changes_enabled?: boolean
  semantic_elapsed_ms?: number
}

export interface TranslationEvent {
  paperId: string
  kind: TranslationKind
  type: 'status' | 'progress' | 'progress_start' | 'progress_update' | 'progress_end' | 'translation_diagnostics' | 'segment' | 'prepared' | 'finished' | 'failed' | 'cancelled'
  message?: string
  completed?: number
  total?: number
  summary?: string
  segmentId?: string
  translatedHTML?: string
  stage?: string
  stageProgress?: number
  overallProgress?: number
  diagnostics?: BabelDocTranslationDiagnostics
  /** Set when a run stopped because no usable model is configured. */
  needsSetup?: boolean
  logPath?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type SelectionAssistantAction = 'translate' | 'explain' | 'ask'

export interface AssistantSource {
  id: string
  kind: 'currentSelection' | 'paperHTML' | 'paperPDF' | 'userNote' | 'paperMetadata' | 'external'
  title: string
  excerpt: string
  pageIndex?: number
  htmlSelector?: string
  attachmentId?: string
  urlString?: string
}

export interface AssistantTurn {
  question: string
  answer: string
  sources: AssistantSource[]
}

export interface AssistantConversation {
  selectionIdentity: string
  action: SelectionAssistantAction
  selection: NoteSelectionContext
  turns: AssistantTurn[]
  savedNoteId?: string
  modifiedAt: string
}

export type AssistantHistoryAnchor = Pick<AssistantConversation, 'selectionIdentity' | 'selection'>

export interface AssistantRequest {
  requestId: string
  paperId: string
  action: SelectionAssistantAction
  selection: NoteSelectionContext
  question?: string
  conversation: AssistantTurn[]
}

export interface AssistantStreamEvent {
  requestId: string
  type: 'progress' | 'partial' | 'done' | 'error'
  text?: string
  sources?: AssistantSource[]
}

export type PdfAnnotationKind = 'highlight' | 'underline' | 'strikeOut' | 'ink' | 'text'

/**
 * A stored annotation: native Freddie's `PDFAnnotationRecord` in its sidecar form. Geometry
 * is in PDF page space (points, origin at the bottom left); dates are ISO 8601 in whole
 * seconds; the identifier is an uppercase UUID.
 */
export interface PdfAnnotationRecord {
  id: string
  pageIndex: number
  kind: PdfAnnotationKind
  bounds: { x: number; y: number; width: number; height: number }
  color: { red: number; green: number; blue: number; alpha: number }
  lineWidth: number
  contents?: string
  quote?: string
  quadrilateralPoints: Array<{ x: number; y: number }>
  inkPaths: Array<Array<{ x: number; y: number }>>
  /** Pressure-aware ink from native Freddie on iPad. */
  inkSamplePaths?: Array<Array<{ x: number; y: number; width: number }>>
  createdAt: string
  modifiedAt: string
}

/** The reader's view of an annotation, in normalized page coordinates (0...1, origin top-left). */
export interface PdfAnnotation {
  id: string
  attachmentId: string
  pageIndex: number
  type: PdfAnnotationKind
  color: string
  lineWidth?: number
  /** Normalized page rectangles for text markup and notes. */
  rects?: Array<{ x: number; y: number; width: number; height: number }>
  /** Normalized ink paths. */
  paths?: Array<Array<{ x: number; y: number }>>
  contents?: string
  createdAt: string
  /** The stored record it was read from; saved unchanged while the annotation is. */
  record?: PdfAnnotationRecord
}

export interface MenuItemSpec {
  id?: string
  label?: string
  type?: 'normal' | 'checkbox' | 'radio' | 'separator' | 'header'
  checked?: boolean
  enabled?: boolean
  accelerator?: string
  submenu?: MenuItemSpec[]
}

export interface MessageBoxSpec {
  type?: 'none' | 'info' | 'warning' | 'error' | 'question'
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  elapsedMs?: number
}

export interface LatexExecutableStatus {
  name: string
  isAvailable: boolean
}

export interface LatexInstallationStatus {
  directory: string
  executables: LatexExecutableStatus[]
  healthy: boolean
}

export interface LatexToolchainStatus {
  latexmkPath?: string
  xelatexPath?: string
  automaticDirectory?: string
  active?: LatexInstallationStatus
  installations: LatexInstallationStatus[]
  healthy: boolean
  detail?: string
}

export type MenuAction =
  | 'add-paper'
  | 'settings'
  | 'about'
  | 'new-folder'
  | 'new-writing'
  | 'quote-in-writing'
  | 'find'
  | 'toggle-inspector'
  | 'toggle-sidebar'
  | 'delete-paper'

export interface WindowRoute {
  kind: 'main' | 'settings' | 'writing' | 'about'
  settingsTab?: string
}

export interface FreddieAPI {
  platform: string
  /** Whether a native window material shows through translucent surfaces (Windows only). */
  backdrop: 'acrylic' | 'none'
  route: WindowRoute
  library: {
    snapshot(): Promise<LibrarySnapshot>
    onChanged(listener: () => void): () => void
    importPaper(request: ImportRequest): Promise<Paper | null>
    cancelImport(operationId: string): Promise<void>
    onImportProgress(listener: (progress: ImportProgress) => void): () => void
    onNativeImportEvent(listener: (event: NativeLibraryImportEvent) => void): () => void
    updatePaper(id: string, patch: Partial<Pick<Paper, 'title' | 'authors' | 'isFavorite' | 'tags' | 'abstract'>>): Promise<void>
    deletePaper(id: string): Promise<void>
    setItemType(paperId: string, itemType: string | null): Promise<void>
    selectPaper(id?: string): Promise<void>
    saveReadingState(state: Omit<ReadingState, 'modifiedAt'>): Promise<void>
    revealPaper(id: string): Promise<void>
    readHTML(paperId: string, attachmentId: string): Promise<string>
    saveHiddenRegions(paperId: string, attachmentId: string, paths: string[]): Promise<void>
    pageCount(paperId: string, attachmentId: string): Promise<{ pageCount: number; hasText: boolean }>
  }
  folders: {
    create(name: string, paperId?: string): Promise<void>
    rename(id: string, name: string): Promise<void>
    remove(id: string): Promise<void>
    move(paperId: string, folderId: string | null): Promise<void>
    setCollapsed(folderIds: string[]): Promise<void>
  }
  notes: {
    create(paperId: string, selection?: NoteSelectionContext, body?: string): Promise<Note>
    update(id: string, body: string): Promise<void>
    remove(id: string): Promise<void>
  }
  settings: {
    save(patch: Partial<AppSettings>): Promise<void>
    saveProvider(provider: Omit<ProviderProfile, 'id' | 'apiKeyConfigured' | 'isBuiltIn' | 'createdAt' | 'modifiedAt'> & { id?: string }, apiKey?: string): Promise<ProviderProfile>
    deleteProvider(id: string): Promise<void>
    testProvider(provider: Pick<ProviderProfile, 'baseURL' | 'apiStyle' | 'testModel'> & { id?: string }, apiKey?: string, webSearch?: boolean): Promise<ProviderTestResult>
    saveModel(model: Omit<ModelProfile, 'id' | 'createdAt' | 'modifiedAt' | 'lastTestedAt'> & { id?: string }): Promise<ModelProfile>
    deleteModel(id: string): Promise<void>
    testModel(model: Omit<ModelProfile, 'createdAt' | 'modifiedAt' | 'lastTestedAt' | 'id'> & { id?: string }): Promise<ProviderTestResult>
    quickSetup(providerId: string, apiKey: string): Promise<ProviderTestResult>
    chooseDirectory(purpose: 'digest' | 'latex'): Promise<string | null>
    latexStatus(): Promise<LatexToolchainStatus>
    openSettings(tab?: string): Promise<void>
    openAbout(): Promise<void>
  }
  outline: {
    load(paperId: string, attachmentId: string, operationId: string): Promise<DocumentOutlineCache>
    select(paperId: string, attachmentId: string, source: DocumentOutlineSource, operationId: string): Promise<DocumentOutlineCache>
    organize(paperId: string, attachmentId: string, operationId: string): Promise<DocumentOutlineCache>
    cancel(operationId: string): Promise<void>
  }
  translation: {
    translateHTML(paperId: string): Promise<void>
    translateLatex(paperId: string): Promise<void>
    translateScannedPDF(paperId: string, lastPage?: number): Promise<void>
    translateBabeldocPDF(paperId: string, pageRange?: string): Promise<void>
    cancel(paperId: string): Promise<void>
    translateAbstract(paperId: string): Promise<string>
    abstractContent(paperId: string, operationId: string): Promise<PaperAbstractContent>
    cancelAbstractContent(operationId: string): Promise<void>
    onEvent(listener: (event: TranslationEvent) => void): () => void
    revealLog(path: string): Promise<void>
    /** Shows the newest translated LaTeX project of the paper in the file manager. */
    revealLatexSource(paperId: string): Promise<void>
  }
  assistant: {
    run(request: AssistantRequest): Promise<void>
    stop(requestId: string): Promise<void>
    onEvent(listener: (event: AssistantStreamEvent) => void): () => void
    conversation(paperId: string, selectionIdentity: string): Promise<AssistantConversation | null>
    saveConversation(paperId: string, conversation: AssistantConversation): Promise<void>
    historyAnchors(paperId: string): Promise<AssistantHistoryAnchor[]>
  }
  annotations: {
    list(paperId: string, attachmentId: string): Promise<PdfAnnotationRecord[]>
    save(paperId: string, attachmentId: string, records: PdfAnnotationRecord[]): Promise<void>
    exportAnnotated(paperId: string, attachmentId: string): Promise<number | null>
  }
  writings: {
    create(markdown?: string, openWindow?: boolean): Promise<WritingMetadata>
    select(id: string): Promise<void>
    load(id: string): Promise<string>
    save(id: string, markdown: string): Promise<void>
    remove(id: string): Promise<void>
    reveal(id: string): Promise<void>
    insertImages(id: string): Promise<string[]>
    imageURL(id: string, relativePath: string): string
    openWindow(): Promise<void>
    closeWindow(): Promise<void>
    isWindowOpen(): Promise<boolean>
    onWindowState(listener: (isOpen: boolean) => void): () => void
    onCommand(listener: (command: WritingCommand) => void): () => void
    sendCommand(command: WritingCommand): Promise<void>
    sendCitation(request: NoteNavigationRequest): Promise<void>
  }
  sync: {
    status(): Promise<SyncStatus>
    onStatus(listener: (status: SyncStatus) => void): () => void
    /** Picks a device credential, confirms its server, connects and syncs. */
    importCredential(): Promise<void>
    syncNow(): Promise<void>
    setAutomatic(value: boolean): Promise<void>
    resolve(conflictId: string, choice: SyncConflictChoice): Promise<void>
    reviewHistory(): Promise<void>
    revealUnavailable(attachmentId: string): Promise<void>
    /** Writings with unsaved edits are left alone by sync until they are saved. */
    setWritingDirty(writingId: string, dirty: boolean): void
    /** The paper a reader or Inspector shows, or null when it closes. Deletions of open papers wait. */
    setReaderActivity(editorId: string, activity: { paperId: string; busy: boolean } | null): void
    /** The note an editor is editing, or null. Sync does not replace it or its paper meanwhile. */
    setNoteEditing(editorId: string, note: { noteId: string; paperId: string } | null): void
    onApplied(listener: (change: SyncAppliedChange) => void): () => void
  }
  digest: {
    copyMarkdown(paperId: string): Promise<void>
    export(paperId: string): Promise<string>
    exportHTMLAsPDF(paperId: string, displayMode: TranslationDisplayMode, fontSize: number): Promise<string | null>
  }
  shell: {
    openExternal(url: string): Promise<void>
    copyText(text: string): Promise<void>
    popupMenu(items: MenuItemSpec[], position?: { x: number; y: number }): Promise<string | null>
    messageBox(spec: MessageBoxSpec): Promise<number>
    assetURL(paperId: string, attachmentId: string): string
    paperBaseURL(paperId: string): string
    onMenuAction(listener: (action: MenuAction) => void): () => void
    onOpenCitation(listener: (request: NoteNavigationRequest) => void): () => void
    setWindowTitle(title: string): void
    pathForFile(file: File): string
  }
}

export type WritingCommand =
  | { type: 'insert-citation'; markdown: string; title?: string }
  | { type: 'reveal-citation'; writingId: string; index: number }
  | { type: 'focus' }
