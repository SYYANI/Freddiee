import electron from 'electron'
import type { FreddieAPI, WindowRoute } from '../../shared/types'

const { contextBridge, ipcRenderer, webUtils } = electron

// The only bridge into the renderer: named operations, never a generic invoke,
// filesystem, or process API.

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T): void => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

function readRoute(): WindowRoute {
  const argument = process.argv.find((value) => value.startsWith('--freddie-route='))
  try {
    const route = JSON.parse(argument?.slice('--freddie-route='.length) ?? '{}') as WindowRoute
    if (['main', 'settings', 'writing', 'about'].includes(route.kind)) return route
  } catch {
    // Fall through to the main window.
  }
  return { kind: 'main' }
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>
const windowsBuild = process.platform === 'win32' ? Number(process.getSystemVersion().split('.')[2]) : 0

const api: FreddieAPI = {
  platform: process.platform,
  windowMaterial: windowsBuild >= 17763 ? 'acrylic' : 'none',
  route: readRoute(),
  library: {
    snapshot: () => invoke('library:snapshot'),
    onChanged: (listener) => subscribe('library:changed', listener),
    importPaper: (request) => invoke('library:import', request),
    cancelImport: (operationId) => invoke('library:cancel-import', operationId),
    onImportProgress: (listener) => subscribe('import:progress', listener),
    updatePaper: (id, patch) => invoke('library:update-paper', id, patch),
    deletePaper: (id) => invoke('library:delete-paper', id),
    setItemType: (paperId, itemType) => invoke('library:set-item-type', paperId, itemType),
    selectPaper: (id) => invoke('library:select', id),
    saveReadingState: (state) => invoke('library:save-reading-state', state),
    revealPaper: (id) => invoke('library:reveal', id),
    readHTML: (paperId, attachmentId) => invoke('library:read-html', paperId, attachmentId),
    saveHiddenRegions: (paperId, attachmentId, paths) => invoke('library:save-hidden-regions', paperId, attachmentId, paths),
    pageCount: (paperId, attachmentId) => invoke('library:page-count', paperId, attachmentId)
  },
  folders: {
    create: (name, paperId) => invoke('folders:create', name, paperId),
    rename: (id, name) => invoke('folders:rename', id, name),
    remove: (id) => invoke('folders:remove', id),
    move: (paperId, folderId) => invoke('folders:move', paperId, folderId),
    setCollapsed: (folderIds) => invoke('folders:set-collapsed', folderIds)
  },
  notes: {
    create: (paperId, selection, body) => invoke('notes:create', paperId, selection, body),
    update: (id, body) => invoke('notes:update', id, body),
    remove: (id) => invoke('notes:remove', id)
  },
  settings: {
    save: (patch) => invoke('settings:save', patch),
    saveProvider: (provider, apiKey) => invoke('settings:save-provider', provider, apiKey),
    deleteProvider: (id) => invoke('settings:delete-provider', id),
    testProvider: (provider, apiKey, webSearch) => invoke('settings:test-provider', provider, apiKey, webSearch),
    saveModel: (model) => invoke('settings:save-model', model),
    deleteModel: (id) => invoke('settings:delete-model', id),
    testModel: (model) => invoke('settings:test-model', model),
    quickSetup: (providerId, apiKey) => invoke('settings:quick-setup', providerId, apiKey),
    chooseDirectory: (purpose) => invoke('settings:choose-directory', purpose),
    latexStatus: () => invoke('settings:latex-status'),
    openSettings: (tab) => invoke('settings:open', tab)
  },
  translation: {
    translateHTML: (paperId) => invoke('translation:html', paperId),
    translateLatex: (paperId) => invoke('translation:latex', paperId),
    translateScannedPDF: (paperId, lastPage) => invoke('translation:scan', paperId, lastPage),
    cancel: (paperId) => invoke('translation:cancel', paperId),
    translateAbstract: (paperId) => invoke('translation:abstract', paperId),
    onEvent: (listener) => subscribe('translation:event', listener),
    revealLog: (path) => invoke('translation:reveal-log', path)
  },
  assistant: {
    run: (request) => invoke('assistant:run', request),
    stop: (requestId) => invoke('assistant:stop', requestId),
    onEvent: (listener) => subscribe('assistant:event', listener),
    conversation: (paperId, identity) => invoke('assistant:conversation', paperId, identity),
    saveConversation: (paperId, conversation) => invoke('assistant:save-conversation', paperId, conversation),
    historyAnchors: (paperId) => invoke('assistant:history', paperId)
  },
  annotations: {
    list: (paperId, attachmentId) => invoke('annotations:list', paperId, attachmentId),
    save: (paperId, attachmentId, annotations) => invoke('annotations:save', paperId, attachmentId, annotations),
    exportAnnotated: (paperId, attachmentId) => invoke('annotations:export', paperId, attachmentId)
  },
  writings: {
    create: (markdown, openWindow) => invoke('writings:create', markdown, openWindow),
    select: (id) => invoke('writings:select', id),
    load: (id) => invoke('writings:load', id),
    save: (id, markdown) => invoke('writings:save', id, markdown),
    remove: (id) => invoke('writings:remove', id),
    reveal: (id) => invoke('writings:reveal', id),
    insertImages: (id) => invoke('writings:insert-images', id),
    imageURL: (id, relativePath) => `freddie://writing/${encodeURIComponent(id)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
    openWindow: () => invoke('writings:open-window'),
    closeWindow: () => invoke('writings:close-window'),
    isWindowOpen: () => invoke('writings:is-window-open'),
    onWindowState: (listener) => subscribe('writing:window-state', listener),
    onCommand: (listener) => subscribe('writing:command', listener),
    sendCommand: (command) => invoke('writings:send-command', command),
    sendCitation: (request) => invoke('writings:send-citation', request)
  },
  digest: {
    copyMarkdown: (paperId) => invoke('digest:copy', paperId),
    export: (paperId) => invoke('digest:export', paperId),
    exportHTMLAsPDF: (paperId, displayMode, fontSize) => invoke('digest:export-html-pdf', paperId, displayMode, fontSize)
  },
  shell: {
    openExternal: (url) => invoke('shell:open-external', url),
    copyText: (text) => invoke('shell:copy-text', text),
    popupMenu: (items, position) => invoke('shell:popup-menu', items, position),
    messageBox: (spec) => invoke('shell:message-box', spec),
    assetURL: (paperId, attachmentId) => `freddie://paper/${encodeURIComponent(paperId)}/a/${encodeURIComponent(attachmentId)}`,
    paperBaseURL: (paperId) => `freddie://paper/${encodeURIComponent(paperId)}/`,
    onMenuAction: (listener) => subscribe('menu:action', listener),
    onOpenCitation: (listener) => subscribe('shell:open-citation', listener),
    setWindowTitle: (title) => ipcRenderer.send('shell:set-title', title),
    pathForFile: (file) => webUtils.getPathForFile(file)
  }
}

contextBridge.exposeInMainWorld('freddie', api)
contextBridge.exposeInMainWorld('freddieSettingsTab', {
  onSelect: (listener: (tab: string) => void) => subscribe('settings:select-tab', listener)
})
