import electron from 'electron'
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, MenuItemConstructorOptions, WebContents } from 'electron'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AppSettings,
  ImportRequest,
  LibrarySnapshot,
  MenuAction,
  MenuItemSpec,
  MessageBoxSpec,
  ModelProfile,
  NoteSelectionContext,
  PdfAnnotation,
  ProviderProfile,
  ProviderTestResult,
  ReadingState,
  TranslationDisplayMode,
  WindowRoute,
  WritingCommand,
  AssistantConversation,
  AssistantRequest,
  Paper
} from '../../shared/types'
import { createTranslator, resolveLanguage, type Translator } from '../../shared/i18n'
import { firstAttachment, resolveItemTypes } from '../../shared/library'
import { digestFileName, makeDigestContent, makeDigestMarkdown } from '../../shared/digest'
import { parseCitation } from '../../shared/writing'
import { AnnotationStore } from './annotations'
import { AssistantService } from './assistant'
import { safeFileName, atomicWriteFile } from './files'
import { ImportError, PaperImporter, readPDFMetadata } from './importer'
import { complete, LLMError, routeFor } from './llm'
import { SecretStore } from './secrets'
import { builtInProviders, FreddieStore } from './store'
import { babelDocVersion, TranslationService, translationDisplayCSS } from './translation'
import { WritingStore } from './writings'
import { importNativeLibrary, nativeLibraryExists } from './nativeLibrary'
import { applyUnifiedToolbar } from './windowChrome'
import { applyHiddenRegions, readableProseColorCSS, readableProseLayoutCSS } from './localizer'
import * as cheerio from 'cheerio'

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell, systemPreferences } = electron
type Window = InstanceType<typeof BrowserWindow>

protocol.registerSchemesAsPrivileged([
  { scheme: 'freddie', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

app.setName('Freddie')
// Freddie, like the native app, always draws a light interface; "Paper Tone" is its dark-room mode.
nativeTheme.themeSource = 'light'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

let store: FreddieStore
let secrets: SecretStore
let writings: WritingStore
let importer: PaperImporter
let translations: TranslationService
let assistant: AssistantService
let annotations: AnnotationStore
let translator: Translator = createTranslator('en')
let htmlTranslatedPaperIds: string[] = []
let hasNativeLibrary = false

const windows: { main?: Window; settings?: Window; writing?: Window; about?: Window } = {}

app.whenReady().then(async () => {
  // Packaged builds take the icon from the bundle; unpackaged runs would otherwise show Electron's.
  if (isMac && !app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'public/icon.png'))
  // FREDDIE_DATA_DIR keeps development and test runs away from the real library.
  const root = process.env.FREDDIE_DATA_DIR || join(app.getPath('appData'), 'Freddie')
  store = new FreddieStore(root)
  const initialization = await store.initialize()
  secrets = new SecretStore(root)
  if (initialization.legacyApiKeyProviderId) await secrets.migrateLegacyKey(initialization.legacyApiKeyProviderId)
  writings = new WritingStore(store.writingsRoot)
  annotations = new AnnotationStore(store)
  updateTranslator()
  synchronizeAppearance()

  importer = new PaperImporter(store, (progress) => broadcast('import:progress', progress), () => translator)
  translations = new TranslationService(store, secrets, (event) => {
    broadcast('translation:event', event)
    if (event.type === 'finished' || event.type === 'failed' || event.type === 'cancelled') void refreshTranslatedIds()
  }, () => translator)
  assistant = new AssistantService(store, secrets, (event) => windows.main?.webContents.send('assistant:event', event), () => translator)
  void refreshTranslatedIds()

  store.onChange(() => {
    updateTranslator()
    broadcast('library:changed')
  })

  registerProtocol()
  registerIpc()
  hasNativeLibrary = await nativeLibraryExists()
  createMenu()
  createMainWindow()
  if (process.env.FREDDIE_IMPORT_NATIVE === '1' && hasNativeLibrary) void runNativeImport(false)

  if (isMac) {
    systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () => {
      synchronizeAppearance()
      broadcast('library:changed')
    })
  }

  app.on('activate', () => {
    if (!windows.main || windows.main.isDestroyed()) createMainWindow()
    else windows.main.show()
  })
}).catch(showFatalError)

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

// MARK: Appearance and language

function systemDarkMode(): boolean {
  if (isMac) return systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark'
  return false
}

/** Dark mode selects Paper Tone and light mode Default, but only when the system changes. */
function synchronizeAppearance(): void {
  const isDark = systemDarkMode()
  const settings = store.database.settings
  const previous = settings.lastSynchronizedSystemDarkMode
  const shouldSynchronize = previous === undefined ? settings.readerAppearance !== 'paper' && isDark : previous !== isDark
  const patch: Partial<AppSettings> = { lastSynchronizedSystemDarkMode: isDark }
  if (shouldSynchronize) patch.readerAppearance = isDark ? 'paper' : 'default'
  if (previous !== isDark || shouldSynchronize) void store.saveSettings(patch)
}

let currentLanguage: 'en' | 'zh-Hans' | undefined

function updateTranslator(): void {
  const language = resolveLanguage(store.database.settings.appLanguage, app.getLocale())
  if (language === currentLanguage) return
  currentLanguage = language
  translator = createTranslator(language)
  if (app.isReady() && windows.main) createMenu()
}

async function refreshTranslatedIds(): Promise<void> {
  htmlTranslatedPaperIds = await translations.htmlTranslatedPaperIds()
  broadcast('library:changed')
}

// MARK: Windows

function rendererURL(route: WindowRoute): { url?: string; file?: string; hash: string } {
  const hash = route.kind === 'main' ? '' : `${route.kind}${route.settingsTab ? `/${route.settingsTab}` : ''}`
  if (process.env.ELECTRON_RENDERER_URL) return { url: `${process.env.ELECTRON_RENDERER_URL}#${hash}`, hash }
  return { file: join(__dirname, '../renderer/index.html'), hash }
}

// Settings and About match the native app's untinted under-window material.
type WindowMaterial = 'sidebar' | 'window' | 'under-window'

function baseWindowOptions(route: WindowRoute, material: WindowMaterial): BrowserWindowConstructorOptions {
  return {
    show: false,
    backgroundColor: process.platform === 'linux' ? '#f3f3f3' : '#00000000',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {
      transparent: true,
      vibrancy: material,
      visualEffectState: 'followWindow' as const,
      trafficLightPosition: { x: 18, y: 18 }
    } : {}),
    ...(!isMac ? { titleBarOverlay: { color: '#00000000', symbolColor: '#1d1d1f', height: 52 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      additionalArguments: [`--freddie-route=${JSON.stringify(route)}`]
    }
  }
}

function loadRoute(window: Window, route: WindowRoute): void {
  const target = rendererURL(route)
  if (target.url) void window.loadURL(target.url)
  else void window.loadFile(target.file!, { hash: target.hash })
}

function hardenWindow(window: Window): void {
  if (isWindows) window.setBackgroundMaterial('acrylic')
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
}

function createMainWindow(): void {
  const route: WindowRoute = { kind: 'main' }
  const window = new BrowserWindow({ width: 1220, height: 780, minWidth: 1040, minHeight: 640, title: 'Freddie', ...baseWindowOptions(route, 'sidebar') })
  windows.main = window
  applyUnifiedToolbar(window)
  hardenWindow(window)
  window.on('closed', () => {
    windows.main = undefined
  })
  loadRoute(window, route)
}

function openSettingsWindow(tab?: string): void {
  if (windows.settings && !windows.settings.isDestroyed()) {
    if (tab) windows.settings.webContents.send('settings:select-tab', tab)
    windows.settings.show()
    windows.settings.focus()
    return
  }
  const route: WindowRoute = { kind: 'settings', settingsTab: tab }
  const window = new BrowserWindow({ width: 920, height: 720, minWidth: 840, minHeight: 520, title: translator('Settings'), fullscreenable: false, ...baseWindowOptions(route, 'under-window') })
  windows.settings = window
  hardenWindow(window)
  window.on('closed', () => {
    windows.settings = undefined
  })
  loadRoute(window, route)
}

function openWritingWindow(): void {
  if (windows.writing && !windows.writing.isDestroyed()) {
    windows.writing.show()
    windows.writing.focus()
    return
  }
  const route: WindowRoute = { kind: 'writing' }
  const window = new BrowserWindow({ width: 760, height: 820, minWidth: 420, minHeight: 360, title: translator('Writing'), ...baseWindowOptions(route, 'window') })
  windows.writing = window
  hardenWindow(window)
  window.on('closed', () => {
    windows.writing = undefined
    broadcast('writing:window-state', false)
  })
  window.once('ready-to-show', () => broadcast('writing:window-state', true))
  loadRoute(window, route)
}

function openAboutWindow(): void {
  if (windows.about && !windows.about.isDestroyed()) {
    windows.about.focus()
    return
  }
  const route: WindowRoute = { kind: 'about' }
  const window = new BrowserWindow({ width: 520, height: 300, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, title: translator('About Freddie'), ...baseWindowOptions(route, 'under-window') })
  windows.about = window
  hardenWindow(window)
  window.on('closed', () => {
    windows.about = undefined
  })
  loadRoute(window, route)
}

function ownedWindows(): Window[] {
  return Object.values(windows).filter((window): window is Window => Boolean(window && !window.isDestroyed()))
}

function broadcast(channel: string, payload?: unknown): void {
  for (const window of ownedWindows()) window.webContents.send(channel, payload)
}

function windowFor(sender: WebContents): Window | undefined {
  return ownedWindows().find((window) => window.webContents === sender)
}

// MARK: Protocol

function registerProtocol(): void {
  protocol.handle('freddie', async (request) => {
    try {
      const url = new URL(request.url)
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      let path: string | undefined
      if (url.hostname === 'paper' && parts.length >= 3) {
        const [paperId, kind, ...rest] = parts
        store.paper(paperId)
        if (kind === 'a') path = store.attachmentPath(paperId, rest[0])
        // Localized page resources live below assets/ (native Freddie: Resources/) next to paper.html.
        else if ((kind === 'assets' || kind === 'Resources') && rest.length) path = store.resolvePaperPath(paperId, [kind, ...rest].join('/'))
      } else if (url.hostname === 'writing' && parts.length >= 2) {
        const [writingId, ...rest] = parts
        if (rest[0] === 'images') path = writings.resolve(writingId, rest.join('/'))
      } else if (url.hostname === 'pdfjs' && parts.length === 2) {
        const [kind, file] = parts
        if (['cmaps', 'standard_fonts'].includes(kind) && /^[A-Za-z0-9_.-]+$/.test(file)) {
          path = join(app.getAppPath(), 'node_modules', 'pdfjs-dist', kind, file)
        }
      }
      if (!path) return new Response('Not found', { status: 404 })
      const response = await net.fetch(pathToFileURL(path).toString())
      const headers = new Headers(response.headers)
      headers.set('cache-control', 'no-cache')
      headers.set('access-control-allow-origin', '*')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

// MARK: IPC

function owned<T extends unknown[], R>(handler: (event: IpcMainInvokeEvent, ...args: T) => R): (event: IpcMainInvokeEvent, ...args: T) => R {
  return (event, ...args) => {
    if (!windowFor(event.sender)) throw new Error('Untrusted IPC sender')
    return handler(event, ...args)
  }
}

function handle<T extends unknown[], R>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: T) => R): void {
  ipcMain.handle(channel, owned(handler))
}

const isUUID = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)

function requireUUID(value: unknown): string {
  if (!isUUID(value)) throw new Error('Invalid identifier')
  return value
}

async function snapshot(): Promise<LibrarySnapshot> {
  const database = store.database
  const configured = await secrets.configuredProviderIds()
  const builtIn = new Set(builtInProviders.map((provider) => provider.id))
  let writingList = [] as LibrarySnapshot['writings']
  let writingError: string | undefined
  try {
    writingList = await writings.loadAll()
  } catch (error) {
    writingError = translator('Unable to load writings: %@', (error as Error).message)
  }
  return store.clone({
    papers: [...database.papers].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    attachments: database.attachments,
    notes: [...database.notes].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    folders: database.folders,
    memberships: database.memberships,
    itemTypeAssignments: database.itemTypeAssignments,
    readingStates: database.readingStates,
    providers: database.providers.map((provider) => ({ ...provider, apiKeyConfigured: configured.has(provider.id), isBuiltIn: builtIn.has(provider.id) })),
    models: database.models,
    settings: database.settings,
    writings: writingList,
    writingError,
    htmlTranslatedPaperIds,
    platform: process.platform,
    systemDarkMode: systemDarkMode()
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function testCompletion(baseURL: string, apiStyle: ProviderProfile['apiStyle'], apiKey: string, model: Omit<ModelProfile, 'id' | 'providerId' | 'name' | 'isEnabled' | 'createdAt' | 'modifiedAt'>, webSearch = false): Promise<ProviderTestResult> {
  const started = Date.now()
  try {
    const route = routeFor({ id: '', name: '', baseURL, apiStyle }, { id: '', ...model }, apiKey)
    const response = await complete({
      baseURL,
      apiStyle,
      apiKey,
      model: route.modelName,
      messages: [{ role: 'user', content: webSearch ? 'Search the web and name one current headline in a few words.' : 'Reply with exactly: OK' }],
      temperature: route.temperature,
      topP: route.topP,
      maxTokens: route.maxTokens ?? (apiStyle === 'anthropic-messages' ? 64 : undefined),
      thinkingMode: route.thinkingMode,
      reasoningEffort: route.reasoningEffort,
      webSearch,
      timeoutMs: 60_000
    })
    if (!response.text) throw new LLMError(translator('The model returned an empty response.'))
    return { ok: true, message: '', elapsedMs: Date.now() - started }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

function registerIpc(): void {
  // Library
  handle('library:snapshot', () => snapshot())
  handle('library:import', async (event, request: ImportRequest) => {
    try {
      if (request.type === 'arxiv') return await importer.importArxiv(String(request.value), Boolean(request.includeHTML), String(request.operationId))
      if (request.type === 'web') return await importer.importWebPage(String(request.url), String(request.operationId))
      let paths = request.paths
      if (!paths?.length) {
        const owner = windowFor(event.sender)!
        const result = await dialog.showOpenDialog(owner, {
          title: translator('Choose PDF...'),
          properties: ['openFile'],
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
        paths = result.filePaths
      }
      let last: Paper | null = null
      const failures: string[] = []
      for (const path of paths ?? []) {
        try {
          last = await importer.importLocalPDF(path)
        } catch (error) {
          failures.push(`${path.split(/[\\/]/).pop()}: ${errorMessage(error)}`)
        }
      }
      if (failures.length) throw new ImportError(failures.join('\n'))
      return last
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return null
      throw new Error(errorMessage(error))
    }
  })
  handle('library:cancel-import', (_event, operationId: string) => importer.cancel(String(operationId)))
  handle('library:update-paper', (_event, id: string, patch: Partial<Paper>) => {
    const allowed: Partial<Paper> = {}
    if (typeof patch.title === 'string') allowed.title = patch.title
    if (typeof patch.abstract === 'string') allowed.abstract = patch.abstract
    if (Array.isArray(patch.authors)) allowed.authors = patch.authors.map(String).map((author) => author.trim()).filter(Boolean)
    if (Array.isArray(patch.tags)) allowed.tags = patch.tags.map(String)
    const favoriteOnly = Object.keys(allowed).length === 0 && typeof patch.isFavorite === 'boolean'
    if (typeof patch.isFavorite === 'boolean') allowed.isFavorite = patch.isFavorite
    // Favoriting leaves modifiedAt alone so it does not reorder the library.
    return store.updatePaper(requireUUID(id), allowed, !favoriteOnly)
  })
  handle('library:delete-paper', async (_event, id: string) => {
    translations.cancel(requireUUID(id))
    await store.deletePaper(id)
  })
  handle('library:set-item-type', (_event, paperId: string, itemType: string | null) => {
    const database = store.database
    const detected = resolveItemTypes(database.papers, database.attachments, []).detectedType(requireUUID(paperId))
    return store.setItemType(paperId, itemType, detected)
  })
  handle('library:select', (_event, id?: string) => store.saveSettings({ lastOpenedPaperId: id && isUUID(id) ? id : undefined }))
  handle('library:save-reading-state', (_event, state: Omit<ReadingState, 'modifiedAt'>) => store.saveReadingState({
    paperId: requireUUID(state.paperId),
    attachmentId: isUUID(state.attachmentId) ? state.attachmentId : undefined,
    readerMode: (['html', 'pdf', 'bilingualPDF', 'translatedPDF'] as const).includes(state.readerMode) ? state.readerMode : 'pdf',
    pageIndex: Math.max(0, Math.floor(Number(state.pageIndex) || 0)),
    scrollRatio: Number(state.scrollRatio) || 0,
    zoomScale: Number(state.zoomScale) || 1
  }))
  handle('library:reveal', (_event, id: string) => {
    const attachment = store.attachments(requireUUID(id))[0]
    if (attachment) shell.showItemInFolder(store.attachmentPath(id, attachment.id))
    else void shell.openPath(store.paperDirectory(id))
  })
  handle('library:read-html', async (_event, paperId: string, attachmentId: string) => {
    const attachment = store.attachment(requireUUID(paperId), requireUUID(attachmentId))
    if (attachment.kind !== 'html') throw new Error('Not an HTML attachment')
    return readFile(store.attachmentPath(paperId, attachmentId), 'utf8')
  })
  handle('library:save-hidden-regions', async (_event, paperId: string, attachmentId: string, paths: string[]) => {
    const attachment = store.attachment(requireUUID(paperId), requireUUID(attachmentId))
    if (attachment.kind !== 'html') throw new Error('Not an HTML attachment')
    if (translations.isRunning(paperId)) throw new Error(translator("Regions can't be edited while a translation is running."))
    const path = store.attachmentPath(paperId, attachmentId)
    const $ = cheerio.load(await readFile(path, 'utf8'))
    applyHiddenRegions($, (Array.isArray(paths) ? paths : []).map(String))
    await atomicWriteFile(path, $.html())
  })
  handle('library:page-count', async (_event, paperId: string, attachmentId: string) => {
    const metadata = await readPDFMetadata(new Uint8Array(await readFile(store.attachmentPath(requireUUID(paperId), requireUUID(attachmentId)))))
    return { pageCount: metadata.pageCount, hasText: true }
  })

  // Folders
  handle('folders:create', (_event, name: string, paperId?: string) => store.createFolder(String(name ?? ''), translator('New Folder'), isUUID(paperId) ? paperId : undefined).then(() => undefined))
  handle('folders:rename', (_event, id: string, name: string) => store.renameFolder(requireUUID(id), String(name)))
  handle('folders:remove', (_event, id: string) => store.removeFolder(requireUUID(id)))
  handle('folders:move', (_event, paperId: string, folderId: string | null) => store.movePaper(requireUUID(paperId), folderId ? requireUUID(folderId) : null))
  handle('folders:set-collapsed', (_event, ids: string[]) => store.saveSettings({ collapsedFolderIds: (Array.isArray(ids) ? ids : []).filter(isUUID) }))

  // Notes
  handle('notes:create', (_event, paperId: string, selection?: NoteSelectionContext, body?: string) => store.createNote(requireUUID(paperId), selection ? {
    attachmentId: isUUID(selection.attachmentId) ? selection.attachmentId : undefined,
    quote: String(selection.quote ?? ''),
    pageIndex: Number.isInteger(selection.pageIndex) ? selection.pageIndex : undefined,
    htmlSelector: typeof selection.htmlSelector === 'string' ? selection.htmlSelector : undefined
  } : undefined, typeof body === 'string' ? body : ''))
  handle('notes:update', (_event, id: string, body: string) => store.updateNote(requireUUID(id), String(body)))
  handle('notes:remove', (_event, id: string) => store.removeNote(requireUUID(id)))

  // Settings
  handle('settings:save', (_event, patch: Partial<AppSettings>) => store.saveSettings(sanitizeSettings(patch)))
  handle('settings:save-provider', async (_event, input: ProviderProfile, apiKey?: string) => {
    const name = String(input.name ?? '').trim()
    if (!name) throw new Error(translator('Provider name cannot be empty.'))
    try {
      new URL(String(input.baseURL))
    } catch {
      throw new Error(translator('The provider Base URL is invalid: %@', String(input.baseURL)))
    }
    const provider = await store.saveProvider({
      id: isUUID(input.id) ? input.id : undefined,
      name,
      baseURL: String(input.baseURL).trim(),
      apiStyle: (['chat-completions', 'responses', 'anthropic-messages'] as const).includes(input.apiStyle) ? input.apiStyle : 'chat-completions',
      testModel: String(input.testModel ?? '').trim(),
      isEnabled: Boolean(input.isEnabled)
    })
    if (apiKey?.trim()) await secrets.setKey(provider.id, apiKey.trim())
    broadcast('library:changed')
    return provider
  })
  handle('settings:delete-provider', async (_event, id: string) => {
    await store.deleteProvider(requireUUID(id))
    await secrets.removeKey(id)
  })
  handle('settings:test-provider', async (_event, input: ProviderProfile, apiKey?: string, webSearch?: boolean) => {
    const key = apiKey?.trim() || (isUUID(input.id) ? await secrets.key(input.id) : undefined)
    if (!key) return { ok: false, message: translator('Enter an API key first.') }
    return testCompletion(String(input.baseURL), input.apiStyle, key, { modelName: String(input.testModel || '') }, Boolean(webSearch))
  })
  handle('settings:save-model', async (_event, input: ModelProfile) => {
    if (!isUUID(input.providerId) || !store.database.providers.some((provider) => provider.id === input.providerId)) throw new Error(translator('Select a provider for the model.'))
    const name = String(input.name ?? '').trim()
    if (!name) throw new Error(translator('Model profile name cannot be empty.'))
    const model = await store.saveModel({
      id: isUUID(input.id) ? input.id : undefined,
      providerId: input.providerId,
      name,
      modelName: String(input.modelName ?? '').trim() || name,
      temperature: finiteOrUndefined(input.temperature),
      topP: finiteOrUndefined(input.topP),
      maxTokens: finiteOrUndefined(input.maxTokens),
      thinkingMode: input.thinkingMode === 'enabled' || input.thinkingMode === 'disabled' ? input.thinkingMode : undefined,
      reasoningEffort: (['low', 'high', 'max'] as const).includes(input.reasoningEffort!) ? input.reasoningEffort : undefined,
      isEnabled: Boolean(input.isEnabled)
    })
    return model
  })
  handle('settings:delete-model', (_event, id: string) => store.deleteModel(requireUUID(id)))
  handle('settings:test-model', async (_event, input: ModelProfile) => {
    if (!isUUID(input.providerId)) return { ok: false, message: translator('Select a provider for the model.') }
    const provider = store.storedProvider(input.providerId)
    const key = await secrets.key(provider.id)
    if (!key) return { ok: false, message: translator('No API key is saved for provider “%@”.', provider.name) }
    const result = await testCompletion(provider.baseURL, provider.apiStyle, key, input)
    if (result.ok && isUUID(input.id)) await store.markModelTested(input.id)
    return result
  })
  handle('settings:quick-setup', async (_event, providerId: string, apiKey: string) => {
    const descriptor = builtInProviders.find((provider) => provider.id === providerId)
    if (!descriptor) return { ok: false, message: translator('The selected translation provider could not be found.') }
    const key = String(apiKey ?? '').trim()
    if (!key) return { ok: false, message: translator('Enter an API key first.') }
    const result = await testCompletion(descriptor.baseURL, descriptor.apiStyle, key, { modelName: descriptor.model.modelName, thinkingMode: descriptor.model.thinkingMode })
    if (!result.ok) return result
    if (!store.database.providers.some((provider) => provider.id === descriptor.id)) {
      await store.saveProvider({ id: descriptor.id, name: descriptor.name, baseURL: descriptor.baseURL, apiStyle: descriptor.apiStyle, testModel: descriptor.testModel, isEnabled: true })
    }
    if (!store.database.models.some((model) => model.id === descriptor.model.id)) {
      await store.saveModel({ id: descriptor.model.id, providerId: descriptor.id, name: descriptor.model.name, modelName: descriptor.model.modelName, thinkingMode: descriptor.model.thinkingMode, isEnabled: true })
    }
    await secrets.setKey(descriptor.id, key)
    await store.saveSettings({ htmlModelId: descriptor.model.id, pdfModelId: descriptor.model.id })
    return result
  })
  handle('settings:choose-directory', async (event, purpose: 'digest' | 'latex') => {
    const result = await dialog.showOpenDialog(windowFor(event.sender)!, {
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: translator('Choose'),
      message: purpose === 'digest' ? translator('Choose a folder for Markdown digest exports.') : undefined
    })
    const path = result.filePaths[0]
    if (!path) return null
    await store.saveSettings(purpose === 'digest' ? { digestExportDirectory: path } : { latexToolchainDirectory: path })
    return path
  })
  handle('settings:latex-status', () => latexStatus())
  handle('settings:babeldoc-status', () => babelDocVersion(store.database.settings.babelDocCommand))
  handle('settings:open', (_event, tab?: string) => openSettingsWindow(typeof tab === 'string' ? tab : undefined))

  // Translation
  handle('translation:html', (_event, paperId: string) => {
    if (translations.isRunning(requireUUID(paperId))) throw new Error(translator('Translation in Progress'))
    void translations.translateHTML(paperId)
  })
  handle('translation:pdf', (_event, paperId: string, lastPage?: number, firstPage?: number) => {
    if (translations.isRunning(requireUUID(paperId))) throw new Error(translator('Translation in Progress'))
    const last = Number.isInteger(lastPage) && lastPage! > 0 ? lastPage : undefined
    const first = Number.isInteger(firstPage) && firstPage! > 0 ? firstPage : 1
    void translations.translatePDF(requireUUID(paperId), last, first)
  })
  handle('translation:latex', async (_event, paperId: string) => {
    const id = requireUUID(paperId)
    if (translations.isRunning(id)) throw new Error(translator('Translation in Progress'))
    const status = await latexStatus()
    if (!status.latexmkPath) throw new Error(translator('PDF compilation requires a TeX distribution that includes latexmk.'))
    void translations.translateLatex(id, status.latexmkPath)
  })
  handle('translation:scan', async (_event, paperId: string, lastPage?: number) => {
    const id = requireUUID(paperId)
    if (translations.isRunning(id)) throw new Error(translator('Translation in Progress'))
    const status = await latexStatus()
    if (!status.xelatexPath) throw new Error(translator('Scanned PDF translation needs XeLaTeX. Install MacTeX, or choose its folder in Settings > LaTeX.'))
    const last = Number.isInteger(lastPage) && lastPage! > 0 ? lastPage : undefined
    void translations.translateScannedPDF(id, status.xelatexPath, last)
  })
  handle('translation:cancel', (_event, paperId: string) => translations.cancel(requireUUID(paperId)))
  handle('translation:abstract', (_event, paperId: string) => translations.translateAbstract(requireUUID(paperId)))
  handle('translation:reveal-log', (_event, path: string) => {
    const resolved = String(path)
    if (!resolved.startsWith(store.libraryRoot)) throw new Error('Invalid log path')
    shell.showItemInFolder(resolved)
  })

  // Assistant
  handle('assistant:run', (_event, request: AssistantRequest) => {
    void assistant.run({ ...request, paperId: requireUUID(request.paperId), requestId: String(request.requestId) })
  })
  handle('assistant:stop', (_event, requestId: string) => assistant.stop(String(requestId)))
  handle('assistant:conversation', (_event, paperId: string, identity: string) => assistant.conversation(requireUUID(paperId), String(identity)))
  handle('assistant:save-conversation', (_event, paperId: string, conversation: AssistantConversation) => assistant.saveConversation(requireUUID(paperId), conversation))
  handle('assistant:history', (_event, paperId: string) => assistant.historyAnchors(requireUUID(paperId)))

  // Annotations
  handle('annotations:list', (_event, paperId: string, attachmentId: string) => annotations.list(requireUUID(paperId), requireUUID(attachmentId)))
  handle('annotations:save', (_event, paperId: string, attachmentId: string, list: PdfAnnotation[]) => annotations.save(requireUUID(paperId), requireUUID(attachmentId), Array.isArray(list) ? list : []))
  handle('annotations:export', async (event, paperId: string, attachmentId: string) => {
    const attachment = store.attachment(requireUUID(paperId), requireUUID(attachmentId))
    const base = attachment.filename.split('/').pop()!.replace(/\.pdf$/i, '')
    const result = await dialog.showSaveDialog(windowFor(event.sender)!, {
      defaultPath: `${safeFileName(base)}-annotated.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      buttonLabel: translator('Export')
    })
    if (!result.filePath) return null
    return annotations.exportAnnotated(paperId, attachmentId, result.filePath)
  })

  // Writings
  handle('writings:create', async (_event, markdown?: string, open?: boolean) => {
    const metadata = await writings.create(typeof markdown === 'string' ? markdown : '')
    await store.saveSettings({ currentWritingId: metadata.id })
    if (open) {
      openWritingWindow()
      windows.writing?.webContents.send('writing:command', { type: 'focus' } satisfies WritingCommand)
    }
    return metadata
  })
  handle('writings:select', (_event, id: string) => store.saveSettings({ currentWritingId: requireUUID(id) }))
  handle('writings:load', (_event, id: string) => writings.loadMarkdown(requireUUID(id)))
  handle('writings:save', async (_event, id: string, markdown: string) => {
    const existing = (await writings.loadAll()).find((writing) => writing.id === requireUUID(id))
    if (!existing) return
    await writings.save(id, String(markdown), existing.createdAt)
    broadcast('library:changed')
  })
  handle('writings:remove', async (_event, id: string) => {
    await writings.delete(requireUUID(id), (path) => shell.trashItem(path))
    const remaining = await writings.loadAll()
    await store.saveSettings({ currentWritingId: remaining[0]?.id })
  })
  handle('writings:reveal', (_event, id: string) => shell.showItemInFolder(writings.markdownPath(requireUUID(id))))
  handle('writings:insert-images', async (event, id: string) => {
    const result = await dialog.showOpenDialog(windowFor(event.sender)!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      buttonLabel: translator('Insert')
    })
    const paths: string[] = []
    for (const path of result.filePaths) paths.push(await writings.importImage(requireUUID(id), path))
    return paths
  })
  handle('writings:open-window', () => openWritingWindow())
  handle('writings:close-window', () => windows.writing?.close())
  handle('writings:is-window-open', () => Boolean(windows.writing && !windows.writing.isDestroyed()))
  handle('writings:send-command', (_event, command: WritingCommand) => {
    const target = windows.writing && !windows.writing.isDestroyed() ? windows.writing : windows.main
    target?.webContents.send('writing:command', command)
    if (target === windows.writing) windows.writing?.show()
  })

  handle('writings:send-citation', (_event, request: { paperId?: string; attachmentId?: string; pageIndex?: number; htmlSelector?: string; quote?: string }) => {
    if (!windows.main) createMainWindow()
    windows.main?.webContents.send('shell:open-citation', {
      id: `${Date.now()}`,
      paperId: isUUID(request.paperId) ? request.paperId : undefined,
      attachmentId: isUUID(request.attachmentId) ? request.attachmentId : undefined,
      pageIndex: Number.isInteger(request.pageIndex) ? request.pageIndex : undefined,
      htmlSelector: typeof request.htmlSelector === 'string' ? request.htmlSelector : undefined,
      quote: typeof request.quote === 'string' ? request.quote : undefined
    })
    windows.main?.show()
  })

  // Digest and export
  handle('digest:copy', (_event, paperId: string) => {
    clipboard.writeText(digestMarkdown(requireUUID(paperId)))
  })
  handle('digest:export', async (_event, paperId: string) => {
    const directory = store.database.settings.digestExportDirectory
    if (!directory) throw new Error(translator('Choose a digest export folder in Settings first.'))
    const paper = store.paper(requireUUID(paperId))
    let target = join(directory, digestFileName(paper.title))
    for (let index = 2; await exists(target); index += 1) target = join(directory, digestFileName(paper.title).replace(/\.md$/, `-${index}.md`))
    await writeFile(target, digestMarkdown(paperId), 'utf8')
    return target.split(/[\\/]/).pop()!
  })
  handle('digest:export-html-pdf', async (event, paperId: string, displayMode: TranslationDisplayMode, fontSize: number) => exportHTMLAsPDF(event.sender, requireUUID(paperId), displayMode, Number(fontSize) || 17))

  // Shell
  handle('shell:open-external', (_event, url: string) => {
    const parsed = new URL(String(url))
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('Unsupported URL')
    return shell.openExternal(parsed.toString())
  })
  handle('shell:copy-text', (_event, text: string) => clipboard.writeText(String(text)))
  handle('shell:popup-menu', (event, items: MenuItemSpec[], position?: { x: number; y: number }) => new Promise<string | null>((resolve) => {
    let chosen: string | null = null
    const menu = Menu.buildFromTemplate(menuTemplate(items, (id) => { chosen = id }))
    menu.popup({
      window: windowFor(event.sender),
      x: position ? Math.round(position.x) : undefined,
      y: position ? Math.round(position.y) : undefined,
      callback: () => setTimeout(() => resolve(chosen), 0)
    })
  }))
  handle('shell:message-box', async (event, spec: MessageBoxSpec) => {
    const result = await dialog.showMessageBox(windowFor(event.sender)!, {
      type: spec.type ?? 'none',
      message: String(spec.message),
      detail: spec.detail ? String(spec.detail) : undefined,
      buttons: (spec.buttons ?? []).map(String),
      defaultId: spec.defaultId,
      cancelId: spec.cancelId,
      noLink: true
    })
    return result.response
  })
  ipcMain.on('shell:set-title', (event, title: string) => {
    const window = windowFor(event.sender)
    if (window) window.setTitle(String(title).slice(0, 200))
  })
}

function finiteOrUndefined(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : value === '' || value === null || value === undefined ? NaN : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function sanitizeSettings(patch: Partial<AppSettings>): Partial<AppSettings> {
  const result: Partial<AppSettings> = {}
  const assign = <K extends keyof AppSettings>(key: K, valid: (value: unknown) => boolean): void => {
    if (key in patch && valid(patch[key])) result[key] = patch[key] as AppSettings[K]
  }
  const isBoolean = (value: unknown): boolean => typeof value === 'boolean'
  const isString = (value: unknown): boolean => typeof value === 'string'
  const optionalUUID = (value: unknown): boolean => value === undefined || value === null || isUUID(value)
  const integerIn = (min: number, max: number) => (value: unknown): boolean => Number.isInteger(value) && (value as number) >= min && (value as number) <= max
  assign('appLanguage', (value) => ['system', 'en', 'zh-Hans'].includes(value as string))
  assign('targetLanguage', (value) => ['EN', 'zh-CN'].includes(value as string))
  assign('htmlTranslationConcurrency', integerIn(1, 16))
  assign('babelDocQPS', integerIn(1, 32))
  assign('pdfTranslationBatchSize', integerIn(1, 50))
  assign('translationGlossary', isString)
  assign('useArxivLatexStructure', isBoolean)
  assign('htmlFontSize', integerIn(13, 28))
  assign('readerAppearance', (value) => value === 'default' || value === 'paper')
  for (const key of ['htmlModelId', 'pdfModelId', 'scannedPageModelId', 'assistantModelId', 'lastOpenedPaperId', 'currentWritingId'] as const) assign(key, optionalUUID)
  assign('assistantWebSearch', isBoolean)
  assign('inspectorCollapsed', isBoolean)
  assign('inspectorMode', (value) => value === 'paper' || value === 'writing')
  assign('digestTemplate', isString)
  assign('digestExportDirectory', (value) => value === undefined || value === null)
  assign('latexToolchainDirectory', (value) => value === undefined || value === null)
  assign('latexTranslationEnabled', isBoolean)
  assign('babelDocCommand', (value) => isString(value) && (value as string).trim().length > 0)
  assign('babelDocArguments', (value) => Array.isArray(value) && value.every(isString))
  assign('quickSetupHidden', isBoolean)
  assign('translationSetupNoticeHandled', isBoolean)
  assign('scannedTranscriptionPaperIds', (value) => Array.isArray(value) && value.every(isUUID))
  for (const key of Object.keys(result) as Array<keyof AppSettings>) if (result[key] === null) result[key] = undefined as never
  return result
}

function menuTemplate(items: MenuItemSpec[], choose: (id: string) => void): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' }
    if (item.type === 'header') return { label: item.label, enabled: false }
    return {
      label: item.label,
      type: item.type === 'checkbox' || item.type === 'radio' ? item.type : 'normal',
      checked: item.checked,
      enabled: item.enabled !== false,
      accelerator: item.accelerator,
      registerAccelerator: false,
      submenu: item.submenu ? menuTemplate(item.submenu, choose) : undefined,
      click: item.id && !item.submenu ? () => choose(item.id!) : undefined
    }
  })
}

function digestMarkdown(paperId: string): string {
  const paper = store.paper(paperId)
  const content = makeDigestContent(paper, store.notes(paperId), translator)
  if (!content) throw new Error(translator('This paper does not have enough metadata to create a digest.'))
  const locale = currentLanguage === 'zh-Hans' ? 'zh-CN' : 'en-US'
  return makeDigestMarkdown(content, translator, locale, store.database.settings.digestTemplate)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function exportHTMLAsPDF(sender: WebContents, paperId: string, displayMode: TranslationDisplayMode, fontSize: number): Promise<string | null> {
  const paper = store.paper(paperId)
  const html = firstAttachment(store.attachments(paperId), 'html')
  if (!html) throw new Error(translator('No HTML attachment is available for this paper.'))
  const title = paper.title.split(/[/:\n\r]/).filter(Boolean).join('-').slice(0, 120) || 'paper'
  const result = await dialog.showSaveDialog(windowFor(sender)!, {
    defaultPath: `${safeFileName(title)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    buttonLabel: translator('Export'),
    message: translator('Export the HTML using the current original, bilingual, or translated display mode.')
  })
  if (!result.filePath) return null
  const source = await readFile(store.attachmentPath(paperId, html.id), 'utf8')
  const mode = ['original', 'bilingual', 'translated'].includes(displayMode) ? displayMode : 'bilingual'
  const extraCSS = `<style>${translationDisplayCSS}${readableProseLayoutCSS}${readableProseColorCSS}:root{--rp-reader-font-size:${fontSize}px}body.rp-readability-body .rp-readability-content{font-size:${fontSize}px!important}body{-webkit-print-color-adjust:exact}</style>`
  const prepared = source.replace(/<html([^>]*)>/i, `<html$1 data-rp-display-mode="${mode}">`).replace(/<\/head>/i, `${extraCSS}</head>`)
  const temporary = store.resolvePaperPath(paperId, `assets/.export-${Date.now()}.html`)
  await atomicWriteFile(temporary, prepared)
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } })
  try {
    await window.loadURL(`freddie://paper/${paperId}/assets/${temporary.split(/[\\/]/).pop()}`)
    const pdf = await window.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
    await atomicWriteFile(result.filePath, pdf)
    return result.filePath.split(/[\\/]/).pop()!
  } finally {
    window.destroy()
    await rm(temporary, { force: true })
  }
}

async function findExecutable(name: string, directories: string[]): Promise<string | undefined> {
  const extensions = isWindows ? ['.exe', '.bat', '.cmd', ''] : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // Keep looking.
      }
    }
  }
  return undefined
}

async function latexStatus() {
  const manual = store.database.settings.latexToolchainDirectory
  const common = isMac
    ? ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/texbin']
    : isWindows
      ? ['C:\\texlive\\2025\\bin\\windows', 'C:\\texlive\\2024\\bin\\windows', 'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64']
      : ['/usr/bin', '/usr/local/bin', '/usr/local/texlive/2025/bin/x86_64-linux', '/usr/local/texlive/2024/bin/x86_64-linux']
  const pathDirectories = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const automaticLatexmk = await findExecutable('latexmk', [...pathDirectories, ...common])
  const latexmkPath = manual ? await findExecutable('latexmk', [manual]) : automaticLatexmk
  const directory = latexmkPath ? join(latexmkPath, '..') : undefined
  const xelatexPath = directory ? await findExecutable('xelatex', [directory]) : undefined
  return {
    latexmkPath,
    xelatexPath,
    automaticDirectory: automaticLatexmk ? join(automaticLatexmk, '..') : undefined,
    healthy: Boolean(latexmkPath && xelatexPath),
    detail: latexmkPath ? undefined : manual ? translator('The selected folder does not contain latexmk.') : undefined
  }
}

// MARK: Native library import

async function runNativeImport(confirm: boolean): Promise<void> {
  const owner = windows.main
  if (confirm && owner) {
    const { response } = await dialog.showMessageBox(owner, {
      type: 'question',
      message: translator('Import Library from Freddie for macOS?'),
      detail: translator('Papers, notes, folders, translations, reading positions and writings are copied from the native app. Papers already in this library are skipped, and the native library is not changed. API keys are not copied.'),
      buttons: [translator('Import'), translator('Cancel')],
      defaultId: 0,
      cancelId: 1
    })
    if (response !== 0) return
  }
  try {
    const result = await store.batch(() => importNativeLibrary(store, store.writingsRoot))
    await refreshTranslatedIds()
    if (owner && confirm) {
      await dialog.showMessageBox(owner, {
        type: 'info',
        message: translator('Import Complete'),
        detail: translator('Imported %lld papers, %lld notes and %lld writings.', result.papers, result.notes, result.writings),
        buttons: [translator('OK')]
      })
    }
  } catch (error) {
    if (owner) dialog.showErrorBox(translator('Unable to Import Paper'), errorMessage(error))
  }
}

// MARK: Menu

function sendMenu(action: MenuAction): void {
  const focused = BrowserWindow.getFocusedWindow()
  if (action === 'settings') return openSettingsWindow()
  if (action === 'about') return openAboutWindow()
  const target = focused && focused === windows.writing && action === 'new-writing' ? windows.writing : windows.main
  if (!target || target.isDestroyed()) {
    createMainWindow()
    return
  }
  target.webContents.send('menu:action', action)
}

function createMenu(): void {
  const t = translator
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'Freddie',
      submenu: [
        { label: t('About Freddie'), click: () => sendMenu('about') },
        { type: 'separator' as const },
        { label: `${t('Settings')}…`, accelerator: 'Command+,', click: () => sendMenu('settings') },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: t('File'),
      submenu: [
        { label: t('Add Paper'), accelerator: 'CmdOrCtrl+O', click: () => sendMenu('add-paper') },
        { label: t('New Folder…'), accelerator: 'CmdOrCtrl+Shift+N', click: () => sendMenu('new-folder') },
        { label: t('New Writing'), accelerator: 'CmdOrCtrl+Alt+N', click: () => sendMenu('new-writing') },
        ...(hasNativeLibrary ? [{ type: 'separator' as const }, { label: t('Import Library from Freddie for macOS…'), click: () => void runNativeImport(true) }] : []),
        { type: 'separator' },
        ...(!isMac ? [{ label: `${t('Settings')}…`, accelerator: 'Ctrl+,', click: () => sendMenu('settings') }, { type: 'separator' as const }] : []),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: t('Edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: t('Quote in Writing'), accelerator: 'CmdOrCtrl+Shift+E', click: () => sendMenu('quote-in-writing') },
        { label: t('Find'), accelerator: 'CmdOrCtrl+F', click: () => sendMenu('find') }
      ]
    },
    {
      label: t('View'),
      submenu: [
        { label: t('Show Inspector'), accelerator: 'CmdOrCtrl+Alt+I', click: () => sendMenu('toggle-inspector') },
        { label: t('Show Sidebar'), accelerator: 'CmdOrCtrl+Alt+S', click: () => sendMenu('toggle-sidebar') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }, { role: 'reload' as const }] : [])
      ]
    },
    { label: t('Window'), role: 'windowMenu' },
    {
      label: t('Help'),
      role: 'help',
      submenu: [
        ...(!isMac ? [{ label: t('About Freddie'), click: () => sendMenu('about') }] : []),
        { label: 'github.com/SYYANI/Freddie', click: () => void shell.openExternal('https://github.com/SYYANI/Freddie') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function showFatalError(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  dialog.showErrorBox('Freddie could not start', message.slice(0, 4000))
  app.quit()
}

// Citation links (readpaper://) clicked in other apps open the cited paper.
app.setAsDefaultProtocolClient('readpaper')
app.on('open-url', (event, url) => {
  event.preventDefault()
  const citation = parseCitation(url)
  if (citation && windows.main) {
    windows.main.webContents.send('shell:open-citation', { id: `${Date.now()}`, ...citation, quote: citation.quotePrefix })
    windows.main.show()
  }
})

