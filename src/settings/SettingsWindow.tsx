import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, LatexToolchainStatus, LLMAPIStyle, LLMReasoningEffort, LLMThinkingMode, ModelProfile, ProviderProfile } from '../../shared/types'
import { defaultDigestTemplate, digestPlaceholders } from '../../shared/digest'
import { formatDate, useApp } from '../app/context'
import { confirmDestructive, errorText, popupMenu } from '../app/native'
import { Button, Checkbox, Spinner, Switch } from '../ui/controls'
import { Disclosure, FieldRow, FormNote, FormRow, FormSection, MenuPicker, Stepper, TextInput } from '../ui/form'
import { Icon } from '../ui/Icon'

type Tab = 'general' | 'reader' | 'latex' | 'digest' | 'providers' | 'models'

const tabs: Array<{ id: Tab; title: string; icon: string }> = [
  { id: 'general', title: 'General', icon: 'gearshape' },
  { id: 'reader', title: 'Reader', icon: 'book.closed' },
  { id: 'latex', title: 'LaTeX', icon: 'text.document' },
  { id: 'digest', title: 'Digest', icon: 'doc.plaintext' },
  { id: 'providers', title: 'Providers', icon: 'network' },
  { id: 'models', title: 'Models', icon: 'sparkles.rectangle.stack' }
]

// Built-in providers, in the order the quick setup lists them.
const quickSetupProviders = [
  { id: '1c613f2b-6209-4e63-b9e1-9dfb415b6cd3', name: 'OpenAI', model: 'OpenAI GPT-5.6 Terra', baseURL: 'https://api.openai.com/v1', keyPage: 'https://platform.openai.com/api-keys' },
  { id: '71c0bb1c-d797-431f-8bd0-96e0a8c579b5', name: 'DeepSeek', model: 'DeepSeek V4 Flash', baseURL: 'https://api.deepseek.com', keyPage: 'https://platform.deepseek.com/api_keys' },
  { id: 'e92e2d96-5184-4522-8fb5-df1fc53621ac', name: 'Anthropic', model: 'Claude Opus 5.5', baseURL: 'https://api.anthropic.com/v1', keyPage: 'https://console.anthropic.com/settings/keys' }
]

function save(patch: Partial<AppSettings>): void {
  void window.freddie.settings.save(patch)
}

function isErrorMessage(message: string): boolean {
  return /(error|failed|invalid|unable|cannot|must|HTTP \d|错误|失败|无效|无法|必须|不能)/i.test(message)
}

function StatusLabel({ message }: { message?: string | null }): JSX.Element | null {
  if (!message) return null
  return <FormNote error={isErrorMessage(message)}>{message}</FormNote>
}

export function SettingsWindow(): JSX.Element {
  const { t } = useApp()
  const [tab, setTab] = useState<Tab>(() => (tabs.some((item) => item.id === window.freddie.route.settingsTab) ? window.freddie.route.settingsTab as Tab : 'general'))

  useEffect(() => {
    const bridge = (window as unknown as { freddieSettingsTab?: { onSelect(listener: (tab: string) => void): () => void } }).freddieSettingsTab
    return bridge?.onSelect((value) => {
      if (tabs.some((item) => item.id === value)) setTab(value as Tab)
    })
  }, [])

  const title = t(tabs.find((item) => item.id === tab)!.title)
  useEffect(() => {
    window.freddie.shell.setWindowTitle(title)
  }, [title])

  return (
    <div className="settings-window">
      <div className="settings-titlebar drag-region">
        <div className="settings-title">{title}</div>
        <div className="settings-tabs no-drag" role="tablist">
          {tabs.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={item.id === tab} className={`settings-tab ${item.id === tab ? 'selected' : ''}`} onClick={() => setTab(item.id)}>
              <Icon name={item.icon} size={22} weight={1.5} />
              <span>{t(item.title)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="settings-content">
        {tab === 'general' && <GeneralTab onSelectTab={setTab} />}
        {tab === 'reader' && <ReaderTab />}
        {tab === 'latex' && <LatexTab />}
        {tab === 'digest' && <DigestTab />}
        {tab === 'providers' && <ProvidersTab />}
        {tab === 'models' && <ModelsTab />}
      </div>
    </div>
  )
}

function useModelChoices(): Array<{ value: string; title: string }> {
  const { snapshot } = useApp()
  return useMemo(() => snapshot.models
    .map((model) => ({ value: model.id, title: `${snapshot.providers.find((provider) => provider.id === model.providerId)?.name ?? '?'} / ${model.name}` }))
    .sort((a, b) => a.title.localeCompare(b.title)), [snapshot.models, snapshot.providers])
}

// MARK: General

function GeneralTab({ onSelectTab }: { onSelectTab: (tab: Tab) => void }): JSX.Element {
  const { snapshot, t } = useApp()
  const settings = snapshot.settings
  const [glossary, setGlossary] = useState(settings.translationGlossary)
  const glossaryTimer = useRef<ReturnType<typeof setTimeout>>()

  const updateGlossary = (value: string): void => {
    setGlossary(value)
    clearTimeout(glossaryTimer.current)
    glossaryTimer.current = setTimeout(() => save({ translationGlossary: value }), 400)
  }

  return (
    <div className="settings-form">
      <FormSection title={t('Getting Started')}>
        {settings.quickSetupHidden ? (
          <FormRow label={<span className="secondary inline-icon"><Icon name="checkmark.circle.fill" size={15} />{t('Getting started guide is hidden.')}</span>}>
            <Button onClick={() => save({ quickSetupHidden: false })}>{t('Show Guide Again')}</Button>
          </FormRow>
        ) : (
          <GettingStarted onSelectTab={onSelectTab} />
        )}
      </FormSection>

      <FormSection title={t('Language')}>
        <FormRow label={t('App language')}>
          <MenuPicker
            value={settings.appLanguage}
            onChange={(value) => save({ appLanguage: value })}
            options={[{ value: 'system', title: t('Follow System') }, { value: 'en', title: 'English' }, { value: 'zh-Hans', title: '简体中文' }]}
          />
        </FormRow>
      </FormSection>

      <FormSection title={t('Translation')}>
        <FormRow label={t('Target language')}>
          <MenuPicker value={settings.targetLanguage} onChange={(value) => save({ targetLanguage: value })} options={[{ value: 'EN', title: 'English' }, { value: 'zh-CN', title: '中文（简体）' }]} />
        </FormRow>
        <FormRow stacked label={t('Optional glossary')}>
          <textarea className="field-well template-editor small" value={glossary} onChange={(event) => updateGlossary(event.target.value)} spellCheck={false} />
        </FormRow>
        <FormRow>
          <Button destructive disabled={!glossary} onClick={() => updateGlossary('')}>{t('Clear glossary')}</Button>
        </FormRow>
        <FormRow><FormNote>{t('One term per line, for example “large language model = 大语言模型”.')}</FormNote></FormRow>
      </FormSection>

      <FormSection title={t('Advanced')}>
        <FormRow stacked>
          <Disclosure title={t('Translation Performance')}>
            <div className="stepper-row">
              <span>{t('HTML concurrency: %d', settings.htmlTranslationConcurrency)}</span>
              <Stepper value={settings.htmlTranslationConcurrency} min={1} max={12} onChange={(value) => save({ htmlTranslationConcurrency: value })} />
            </div>
            <div className="stepper-row">
              <span>{t('PDF pages per batch: %d', settings.pdfTranslationBatchSize)}</span>
              <Stepper value={settings.pdfTranslationBatchSize} min={1} max={50} onChange={(value) => save({ pdfTranslationBatchSize: value })} />
            </div>
            <FormNote>{t('Lower concurrency if your provider reports rate limits.')}</FormNote>
          </Disclosure>
        </FormRow>
      </FormSection>

      {/* macOS reaches About from the app menu; elsewhere the menu bar is hidden. */}
      {window.freddie.platform !== 'darwin' && (
        <FormSection>
          <FormRow label={<span className="secondary">{t('Version %@ (Build %@)', __APP_VERSION__, __APP_BUILD__)}</span>}>
            <Button onClick={() => void window.freddie.settings.openAbout()}>{`${t('About Freddie')}…`}</Button>
          </FormRow>
        </FormSection>
      )}
    </div>
  )
}

function GettingStarted({ onSelectTab }: { onSelectTab: (tab: Tab) => void }): JSX.Element {
  const { snapshot, t } = useApp()
  const settings = snapshot.settings
  const modelName = (id?: string): string | undefined => {
    const model = snapshot.models.find((item) => item.id === id)
    if (!model) return undefined
    return `${snapshot.providers.find((provider) => provider.id === model.providerId)?.name ?? '?'} / ${model.name}`
  }
  const ready = Boolean(modelName(settings.htmlModelId) && modelName(settings.pdfModelId))
  const [showForm, setShowForm] = useState(false)
  const [providerId, setProviderId] = useState(quickSetupProviders[0].id)
  const [apiKey, setAPIKey] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const descriptor = quickSetupProviders.find((provider) => provider.id === providerId)!
  const hasStoredKey = snapshot.providers.find((provider) => provider.id === providerId)?.apiKeyConfigured ?? false
  const summary = settings.htmlModelId === settings.pdfModelId
    ? t('HTML and PDF translation use %@.', modelName(settings.htmlModelId) ?? '')
    : t('HTML translation uses %1$@; PDF translation uses %2$@.', modelName(settings.htmlModelId) ?? '', modelName(settings.pdfModelId) ?? '')

  const runQuickSetup = async (): Promise<void> => {
    setRunning(true)
    setStatus(null)
    try {
      const result = await window.freddie.settings.quickSetup(providerId, apiKey)
      if (result.ok) {
        setStatus(t('Connected. HTML and PDF translation now use %@.', descriptor.model))
        setShowForm(false)
        setAPIKey('')
      } else setStatus(result.message)
    } catch (error) {
      setStatus(errorText(error))
    } finally {
      setRunning(false)
    }
  }

  const step = (title: string, detail: string, complete: boolean): JSX.Element => (
    <div className="onboarding-step">
      <Icon name={complete ? 'checkmark.circle.fill' : 'circle.dashed'} size={20} className={complete ? 'green' : 'secondary'} />
      <div>
        <div className="onboarding-title">{title}</div>
        <div className="onboarding-detail secondary">{detail}</div>
      </div>
    </div>
  )

  return (
    <>
      <FormRow stacked>
        {step(t('1. Connect a translation service'), ready ? summary : t('Paste an API key to use it for HTML and PDF translation.'), ready)}
        {ready && !showForm ? (
          <div className="quick-setup">
            <StatusLabel message={status} />
            <div><Button onClick={() => { setStatus(null); setShowForm(true) }}>{t('Use Another Provider')}</Button></div>
          </div>
        ) : (
          <div className="quick-setup">
            <div className="native-segmented" role="radiogroup">
              {quickSetupProviders.map((provider) => (
                <button key={provider.id} type="button" role="radio" aria-checked={provider.id === providerId} className={provider.id === providerId ? 'selected' : ''} disabled={running} onClick={() => { setProviderId(provider.id); setAPIKey(''); setStatus(null) }}>
                  {provider.name}
                </button>
              ))}
            </div>
            <FieldRow label={t('API key')}>
              <TextInput secure value={apiKey} onChange={setAPIKey} placeholder={hasStoredKey && !apiKey ? '••••••••••••' : ''} />
            </FieldRow>
            <div className="quick-setup-hint">
              <FormNote>{t('Uses %1$@ at %2$@.', descriptor.model, descriptor.baseURL)}</FormNote>
              <span className="spacer" />
              <button type="button" className="link-button small" onClick={() => void window.freddie.shell.openExternal(descriptor.keyPage)}>{t('Get an API Key')}</button>
            </div>
            <div className="button-row">
              <Button prominent disabled={running || (!apiKey.trim() && !hasStoredKey)} onClick={() => void runQuickSetup()}>{running ? t('Testing connection...') : t('Test and Use for Translation')}</Button>
              {running && <Spinner />}
              {ready && <Button disabled={running} onClick={() => { setAPIKey(''); setStatus(null); setShowForm(false) }}>{t('Cancel')}</Button>}
            </div>
            <StatusLabel message={status} />
          </div>
        )}
        <div className="more-options">
          <FormNote>{t('More options:')}</FormNote>
          <span className="spacer" />
          {(['providers', 'models', 'reader'] as const).map((tab) => (
            <button key={tab} type="button" className="link-button small" onClick={() => onSelectTab(tab)}>{t(tabs.find((item) => item.id === tab)!.title)}</button>
          ))}
        </div>
      </FormRow>
      <FormRow stacked>
        {step(
          t('2. Import and translate papers'),
          snapshot.papers.length > 0
            ? t('%d paper%@ already in your library. Use Translate in the reader toolbar.', snapshot.papers.length, snapshot.papers.length === 1 ? '' : 's')
            : t('Return to the main window, add an arXiv paper or local PDF, then use Translate in the reader toolbar.'),
          snapshot.papers.length > 0
        )}
      </FormRow>
      <FormRow>
        <Button onClick={() => save({ quickSetupHidden: true })}>{t('Skip')}</Button>
      </FormRow>
    </>
  )
}

// MARK: Reader

function ReaderTab(): JSX.Element {
  const { snapshot, t } = useApp()
  const settings = snapshot.settings
  const choices = useModelChoices()
  return (
    <div className="settings-form">
      <FormSection title={t('HTML Typography')}>
        <FormRow label={t('HTML Font Size')}>
          <span className="secondary tabular">{settings.htmlFontSize}</span>
          <Stepper value={settings.htmlFontSize} min={13} max={28} onChange={(value) => save({ htmlFontSize: value })} />
        </FormRow>
        <FormRow>
          <Button disabled={settings.htmlFontSize === 17} onClick={() => save({ htmlFontSize: 17 })}>{t('Reset Font Size')}</Button>
        </FormRow>
      </FormSection>
      <FormSection title={t('Reader Appearance')}>
        <FormRow label={t('Reader Appearance')} help={t('System appearance changes automatically select Default for Light Mode and Paper Tone for Dark Mode. You can switch either option manually afterward.')}>
          <div className="native-segmented" role="radiogroup">
            {(['default', 'paper'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={settings.readerAppearance === value} className={settings.readerAppearance === value ? 'selected' : ''} onClick={() => save({ readerAppearance: value })}>
                {value === 'default' ? t('Default') : t('Paper Tone')}
              </button>
            ))}
          </div>
        </FormRow>
      </FormSection>
      <FormSection title={t('Translation Routes')}>
        <FormRow label={t('HTML Model')}>
          <MenuPicker value={settings.htmlModelId ?? ''} onChange={(value) => save({ htmlModelId: value || undefined })} options={[{ value: '', title: t('Not Selected') }, ...choices]} />
        </FormRow>
        <FormRow label={t('Document Translation Model')}>
          <MenuPicker value={settings.pdfModelId ?? ''} onChange={(value) => save({ pdfModelId: value || undefined })} options={[{ value: '', title: t('Not Selected') }, ...choices]} />
        </FormRow>
        <FormRow label={t('Page Transcription and Review Model')} help={t('Translating a scanned PDF sends each page image to this model, which must accept image input; the document translation model then translates the transcribed text.')}>
          <MenuPicker value={settings.scannedPageModelId ?? ''} onChange={(value) => save({ scannedPageModelId: value || undefined })} options={[{ value: '', title: t('Use Document Translation Model') }, ...choices]} />
        </FormRow>
        <FormRow label={t('Reading Assistant Model')}>
          <MenuPicker value={settings.assistantModelId ?? ''} onChange={(value) => save({ assistantModelId: value || undefined })} options={[{ value: '', title: t('Use HTML Model') }, ...choices]} />
        </FormRow>
        <FormRow label={t('Allow external search for the reading assistant')} help={t("Uses the selected model's server-side web search (Responses API or Anthropic Messages API).")}>
          <Switch checked={settings.assistantWebSearch} onChange={(value) => save({ assistantWebSearch: value })} />
        </FormRow>
      </FormSection>
    </div>
  )
}

// MARK: LaTeX

function LatexTab(): JSX.Element {
  const { snapshot, t } = useApp()
  const settings = snapshot.settings
  const [status, setStatus] = useState<LatexToolchainStatus | null>(null)
  const refresh = async (): Promise<void> => setStatus(await window.freddie.settings.latexStatus())
  useEffect(() => {
    void refresh()
  }, [settings.latexToolchainDirectory])

  return (
    <div className="settings-form">
      <FormSection title={t('TeX Live / MacTeX')}>
        <FormRow stacked><span>{t('If you do not have a TeX distribution installed, MacTeX is recommended. The distribution is installed and maintained separately from Freddie.')}</span></FormRow>
        <FormRow>
          <button type="button" className="link-button" onClick={() => void window.freddie.shell.openExternal(window.freddie.platform === 'darwin' ? 'https://tug.org/mactex/mactex-download.html' : 'https://tug.org/texlive/')}>
            {window.freddie.platform === 'darwin' ? t('Download MacTeX') : t('Download TeX Live')}
          </button>
        </FormRow>
      </FormSection>
      <FormSection title={t('LaTeX Installation')}>
        <FormRow label={t('Toolchain directory')} help={t("Automatic detection checks the app's PATH and common MacTeX, Homebrew, and /usr/local locations. A manually selected directory takes precedence and must contain an executable latexmk.")}>
          <MenuPicker
            value={settings.latexToolchainDirectory ?? ''}
            onChange={(value) => save({ latexToolchainDirectory: value || undefined })}
            options={[
              { value: '', title: status?.automaticDirectory ? t('Automatic (%@)', status.automaticDirectory) : t('Automatic (not found)') },
              ...(status?.installations ?? []).map((installation) => ({ value: installation.directory, title: installation.directory }))
            ]}
          />
        </FormRow>
        <FormRow>
          <div className="button-row">
            <Button onClick={() => void refresh()}>{t('Refresh')}</Button>
            <Button onClick={() => void window.freddie.settings.chooseDirectory('latex')}>{t('Choose Folder')}</Button>
            <Button disabled={!settings.latexToolchainDirectory} onClick={() => save({ latexToolchainDirectory: undefined })}>{t('Use Automatic Detection')}</Button>
          </div>
        </FormRow>
      </FormSection>
      <FormSection title={t('Current LaTeX Toolchain')}>
        <FormRow label={t('Location on Disk')}>
          <span className={status?.active ? 'selectable truncate' : 'secondary'}>{status?.active?.directory ?? t('Not found')}</span>
        </FormRow>
        {status?.active ? (
          <>
            <FormRow stacked><span className={`inline-icon ${status.healthy ? 'green' : 'red'}`}><Icon name={status.healthy ? 'checkmark.circle.fill' : 'xmark.circle.fill'} size={14} />{status.healthy ? t('Basic health check passed') : t('Basic health check failed')}</span></FormRow>
            <FormRow stacked>
              <div className="executables">
                {status.active.executables.map(({ name, isAvailable }) => (
                  <span key={name} className={`inline-icon ${isAvailable ? 'green' : 'secondary'}`}><Icon name={isAvailable ? 'checkmark.circle.fill' : 'xmark.circle'} size={13} />{name}</span>
                ))}
              </div>
            </FormRow>
          </>
        ) : (
          <FormRow stacked><span className="secondary">{t('No usable LaTeX installation was found. Install MacTeX, refresh detection, or choose the TeX binary directory manually.')}</span></FormRow>
        )}
      </FormSection>
    </div>
  )
}

// MARK: Digest

function DigestTab(): JSX.Element {
  const { snapshot, t } = useApp()
  const settings = snapshot.settings
  const [template, setTemplate] = useState(settings.digestTemplate)
  const [status, setStatus] = useState<string | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  const update = (value: string): void => {
    setTemplate(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => save({ digestTemplate: value }), 400)
  }

  const insertPlaceholder = async (anchor: HTMLElement): Promise<void> => {
    const choice = await popupMenu(digestPlaceholders.map((token) => ({ id: token, label: token })), anchor)
    if (!choice) return
    const field = editor.current
    const start = field?.selectionStart ?? template.length
    const end = field?.selectionEnd ?? template.length
    update(template.slice(0, start) + choice + template.slice(end))
    requestAnimationFrame(() => {
      field?.focus()
      field?.setSelectionRange(start + choice.length, start + choice.length)
    })
  }

  return (
    <div className="settings-form">
      <FormSection title={t('Digest Export')}>
        <FormRow label={t('Export directory')}>
          <span className={settings.digestExportDirectory ? 'selectable truncate' : 'secondary'}>{settings.digestExportDirectory ?? t('Not configured')}</span>
        </FormRow>
        <FormRow>
          <div className="button-row">
            <Button prominent onClick={async () => {
              const path = await window.freddie.settings.chooseDirectory('digest')
              if (path) setStatus(t('Export directory saved.'))
            }}>{t('Choose Folder')}</Button>
            <Button destructive disabled={!settings.digestExportDirectory} onClick={() => {
              save({ digestExportDirectory: undefined })
              setStatus(t('Export directory cleared.'))
            }}>{t('Clear')}</Button>
          </div>
        </FormRow>
        <FormRow stacked><FormNote>{t('Markdown export requires a configured folder. Copy Digest can still use the template without an export folder.')}</FormNote></FormRow>
      </FormSection>
      <FormSection title={t('Markdown Template')}>
        <FormRow stacked>
          <textarea ref={editor} className="field-well template-editor mono" value={template} spellCheck={false} onChange={(event) => update(event.target.value)} />
        </FormRow>
        <FormRow>
          <div className="button-row">
            <Button onClick={(event) => void insertPlaceholder(event.currentTarget)}><Icon name="plus" size={12} /> {t('Insert Placeholder')}</Button>
            <Button onClick={() => {
              update(defaultDigestTemplate)
              setStatus(t('Default digest template restored.'))
            }}>{t('Reset Default Template')}</Button>
          </div>
        </FormRow>
        <FormRow stacked><FormNote>{t('Available placeholders: {{dateISO}}, {{title}}, {{slug}}, {{authors}}, {{identifier}}, {{sourceTitle}}, {{sourceURL}}, {{metadataBlock}}, {{abstractBlock}}, {{notesBlock}}, {{generatedBy}}.')}</FormNote></FormRow>
        {status && <FormRow stacked><StatusLabel message={status} /></FormRow>}
      </FormSection>
    </div>
  )
}

// MARK: Providers

const apiStyles: LLMAPIStyle[] = ['chat-completions', 'responses', 'anthropic-messages']

function apiStyleLabel(style: LLMAPIStyle, t: (key: string) => string): string {
  return style === 'responses' ? t('Responses API') : style === 'chat-completions' ? t('Chat Completions') : t('Anthropic Messages API')
}

function EntityList<Item extends { id: string }>({ title, items, selectedId, onSelect, onNew, onDelete, newLabel, row }: {
  title: string
  items: Item[]
  selectedId?: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: () => void
  newLabel: string
  row: (item: Item) => JSX.Element
}): JSX.Element {
  const { t } = useApp()
  return (
    <div className="entity-list">
      <div className="entity-list-header">
        <strong>{title}</strong>
        <span className="count-badge">{items.length}</span>
      </div>
      <div className="entity-list-items">
        {items.map((item, index) => (
          <div key={item.id}>
            <div className={`entity-row ${item.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(item.id)}>{row(item)}</div>
            {index < items.length - 1 && <div className="entity-divider" />}
          </div>
        ))}
      </div>
      <div className="entity-list-toolbar">
        <button type="button" title={newLabel} aria-label={newLabel} onClick={onNew}><Icon name="plus" size={14} /></button>
        <button type="button" title={t('Delete')} aria-label={t('Delete')} disabled={!selectedId} onClick={onDelete}><Icon name="trash" size={13} /></button>
      </div>
    </div>
  )
}

function ProvidersTab(): JSX.Element {
  const { snapshot, t } = useApp()
  const providers = useMemo(() => [...snapshot.providers].sort((a, b) => a.name.localeCompare(b.name)), [snapshot.providers])
  const [selectedId, setSelectedId] = useState<string | undefined>(providers[0]?.id)
  const selected = providers.find((provider) => provider.id === selectedId)
  const blank = { name: '', baseURL: 'https://api.openai.com/v1', apiStyle: 'chat-completions' as LLMAPIStyle, testModel: '', isEnabled: true }
  const [form, setForm] = useState(blank)
  const [apiKey, setAPIKey] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [searchStatus, setSearchStatus] = useState<string | null>(null)
  const [testing, setTesting] = useState<'basic' | 'search' | null>(null)

  const apply = (provider?: ProviderProfile): void => {
    setForm(provider ? { name: provider.name, baseURL: provider.baseURL, apiStyle: provider.apiStyle, testModel: provider.testModel, isEnabled: provider.isEnabled } : blank)
    setAPIKey('')
    setStatus(null)
    setSearchStatus(null)
  }

  useEffect(() => apply(selected), [selectedId])

  const saveProvider = async (): Promise<void> => {
    try {
      const saved = await window.freddie.settings.saveProvider({ id: selectedId, ...form }, apiKey)
      setSelectedId(saved.id)
      setAPIKey('')
      setStatus(t('Provider saved.'))
    } catch (error) {
      setStatus(errorText(error))
    }
  }

  const test = async (webSearch: boolean): Promise<void> => {
    setTesting(webSearch ? 'search' : 'basic')
    if (webSearch) setSearchStatus(t('Testing web search...'))
    else setStatus(t('Testing provider...'))
    const result = await window.freddie.settings.testProvider({ id: selectedId, baseURL: form.baseURL, apiStyle: form.apiStyle, testModel: form.testModel }, apiKey, webSearch)
    const message = result.ok ? t('Provider test passed in %d ms.', result.elapsedMs ?? 0) : result.message
    if (webSearch) setSearchStatus(message)
    else setStatus(message)
    setTesting(null)
  }

  const remove = async (): Promise<void> => {
    if (!selected) return
    if (!(await confirmDestructive(t('Delete'), selected.name, t('Delete'), t('Cancel')))) return
    await window.freddie.settings.deleteProvider(selected.id)
    setSelectedId(undefined)
    apply(undefined)
    setStatus(t('Provider deleted.'))
  }

  return (
    <div className="llm-workspace">
      <EntityList
        title={t('Providers')}
        items={providers}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={() => { setSelectedId(undefined); apply(undefined) }}
        onDelete={() => void remove()}
        newLabel={t('New Provider')}
        row={(provider) => (
          <div className={`entity-row-content ${provider.isEnabled ? '' : 'disabled'}`}>
            <div className="entity-row-top">
              <span className="entity-name">{provider.name}</span>
              <span className="spacer" />
              {provider.apiKeyConfigured && <span className="key-icon" title={t('API key')}>⚿</span>}
              <Icon name={provider.isEnabled ? 'checkmark.circle.fill' : 'xmark.circle.fill'} size={13} className={provider.isEnabled ? 'green' : 'secondary'} />
            </div>
            <div className="caption secondary truncate">{provider.baseURL}</div>
            <div className="caption2 tertiary">{apiStyleLabel(provider.apiStyle, t)}</div>
          </div>
        )}
      />
      <div className="settings-form detail">
        <FormSection title={t('Providers')}>
          <FormRow stacked>
            <div>{t('OpenAI, DeepSeek and Anthropic are ready to use after you save an API key. You can also add custom providers and choose the Responses API, Chat Completions or the Anthropic Messages API.')}</div>
          </FormRow>
          <FormRow stacked><FormNote>{t('API keys are encrypted with the operating system’s credential storage. Leaving the API key field blank while editing keeps the saved key.')}</FormNote></FormRow>
        </FormSection>
        <FormSection title={t('Configuration')}>
          <FormRow stacked><FieldRow label={t('Display name')}><TextInput value={form.name} onChange={(name) => setForm({ ...form, name })} /></FieldRow></FormRow>
          <FormRow stacked><FieldRow label={t('Base URL')}><TextInput value={form.baseURL} onChange={(baseURL) => setForm({ ...form, baseURL })} /></FieldRow></FormRow>
          <FormRow stacked><FieldRow label={t('API protocol')}><MenuPicker value={form.apiStyle} onChange={(apiStyle) => setForm({ ...form, apiStyle })} options={apiStyles.map((style) => ({ value: style, title: apiStyleLabel(style, t) }))} /></FieldRow></FormRow>
          <FormRow stacked><FieldRow label={t('API key')}><TextInput secure value={apiKey} onChange={setAPIKey} placeholder={selected?.apiKeyConfigured ? '••••••••••••' : ''} /></FieldRow></FormRow>
          <FormRow stacked><FieldRow label={t('Test model')}><TextInput value={form.testModel} onChange={(testModel) => setForm({ ...form, testModel })} /></FieldRow></FormRow>
          <FormRow stacked><FieldRow label={t('Enabled')}><Checkbox checked={form.isEnabled} onChange={(isEnabled) => setForm({ ...form, isEnabled })} /></FieldRow></FormRow>
        </FormSection>
        <FormSection title={t('Actions')}>
          <FormRow stacked>
            <div className="button-row">
              <Button prominent onClick={() => void saveProvider()}>{t('Save')}</Button>
              <Button onClick={() => apply(selected)}>{t('Reset')}</Button>
              <Button disabled={testing !== null} onClick={() => void test(false)}>{testing === 'basic' ? t('Testing...') : t('Test')}</Button>
              <Button
                disabled={testing !== null || form.apiStyle === 'chat-completions'}
                title={form.apiStyle === 'chat-completions' ? t('Web search testing requires the Responses API or the Anthropic Messages API.') : t('Test server-side web search and capture its complete trace.')}
                onClick={() => void test(true)}
              >
                {testing === 'search' ? t('Testing web search...') : t('Test Web Search')}
              </Button>
            </div>
            <StatusLabel message={status} />
            <StatusLabel message={searchStatus} />
          </FormRow>
        </FormSection>
      </div>
    </div>
  )
}

// MARK: Models

function ModelsTab(): JSX.Element {
  const { snapshot, t, language } = useApp()
  const providerName = (id: string): string => snapshot.providers.find((provider) => provider.id === id)?.name ?? t('Unknown Provider')
  const models = useMemo(() => [...snapshot.models].sort((a, b) => `${providerName(a.providerId)} ${a.name}`.localeCompare(`${providerName(b.providerId)} ${b.name}`)), [snapshot.models, snapshot.providers])
  const [selectedId, setSelectedId] = useState<string | undefined>(models[0]?.id)
  const selected = models.find((model) => model.id === selectedId)
  interface ModelForm { providerId: string; name: string; modelName: string; isEnabled: boolean; thinkingMode: LLMThinkingMode | ''; reasoningEffort: LLMReasoningEffort | ''; temperature: string; topP: string; maxTokens: string }
  const blank: ModelForm = { providerId: '', name: '', modelName: '', isEnabled: true, thinkingMode: '', reasoningEffort: '', temperature: '', topP: '', maxTokens: '' }
  const [form, setForm] = useState<ModelForm>(blank)
  const [status, setStatus] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const apply = (model?: ModelProfile): void => {
    setForm(model ? {
      providerId: model.providerId,
      name: model.name,
      modelName: model.modelName,
      isEnabled: model.isEnabled,
      thinkingMode: model.thinkingMode ?? '',
      reasoningEffort: model.reasoningEffort ?? '',
      temperature: model.temperature?.toString() ?? '',
      topP: model.topP?.toString() ?? '',
      maxTokens: model.maxTokens?.toString() ?? ''
    } : blank)
    setStatus(null)
  }

  useEffect(() => apply(selected), [selectedId])

  const parsed = (): Omit<ModelProfile, 'id' | 'createdAt' | 'modifiedAt' | 'lastTestedAt'> => {
    const number = (value: string, label: string, integer: boolean): number | undefined => {
      if (!value.trim()) return undefined
      const result = Number(value)
      if (!Number.isFinite(result) || (integer && !Number.isInteger(result))) throw new Error(integer ? t('%@ must be an integer.', label) : t('%@ must be a number.', label))
      return result
    }
    return {
      providerId: form.providerId,
      name: form.name,
      modelName: form.modelName,
      isEnabled: form.isEnabled,
      thinkingMode: form.thinkingMode || undefined,
      reasoningEffort: form.thinkingMode === 'disabled' ? undefined : form.reasoningEffort || undefined,
      temperature: number(form.temperature, t('Temperature'), false),
      topP: number(form.topP, t('Top-P'), false),
      maxTokens: number(form.maxTokens, t('Max tokens'), true)
    }
  }

  const saveModel = async (): Promise<void> => {
    try {
      const saved = await window.freddie.settings.saveModel({ id: selectedId, ...parsed() })
      setSelectedId(saved.id)
      setStatus(t('Model saved.'))
    } catch (error) {
      setStatus(errorText(error))
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setStatus(t('Testing model...'))
    try {
      const result = await window.freddie.settings.testModel({ id: selectedId, ...parsed() })
      setStatus(result.ok ? t('Model test passed in %d ms.', result.elapsedMs ?? 0) : result.message)
    } catch (error) {
      setStatus(errorText(error))
    } finally {
      setTesting(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!selected) return
    if (!(await confirmDestructive(t('Delete'), selected.name, t('Delete'), t('Cancel')))) return
    await window.freddie.settings.deleteModel(selected.id)
    setSelectedId(undefined)
    apply(undefined)
    setStatus(t('Model deleted.'))
  }

  const providerOptions = [{ value: '', title: t('Select Provider') }, ...snapshot.providers.map((provider) => ({ value: provider.id, title: provider.name }))]

  return (
    <div className="llm-workspace">
      <EntityList
        title={t('Models')}
        items={models}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={() => { setSelectedId(undefined); apply(undefined) }}
        onDelete={() => void remove()}
        newLabel={t('New Model')}
        row={(model) => (
          <div className={`entity-row-content ${model.isEnabled ? '' : 'disabled'}`}>
            <div className="entity-row-top">
              <span className="entity-name">{model.name}</span>
              <span className="spacer" />
              {model.lastTestedAt && <Icon name="checkmark.circle.fill" size={13} className="secondary" />}
              <Icon name={model.isEnabled ? 'checkmark.circle.fill' : 'xmark.circle.fill'} size={13} className={model.isEnabled ? 'green' : 'secondary'} />
            </div>
            <div className="caption secondary truncate">{providerName(model.providerId)}</div>
            <div className="caption2 secondary truncate">{model.modelName}</div>
          </div>
        )}
      />
      <div className="settings-form detail">
        <FormSection title={t('Models')}>
          <FormRow stacked><div>{t('A model profile points to one provider and stores the exact model name plus optional sampling parameters. You can create separate profiles for fast HTML translation and heavier PDF work.')}</div></FormRow>
          <FormRow stacked><FormNote>{t('Profile name is only for display inside ReadPaper. Model name must match the real model identifier accepted by your provider.')}</FormNote></FormRow>
        </FormSection>
        <FormSection title={t('Configuration')}>
          <FormRow stacked><FieldRow label={t('Provider')}><MenuPicker value={form.providerId} onChange={(providerId) => setForm({ ...form, providerId })} options={providerOptions} /></FieldRow></FormRow>
          <FormRow stacked><FieldRow label={t('Profile name')}><TextInput value={form.name} onChange={(name) => setForm({ ...form, name })} /></FieldRow></FormRow>
          <FormRow stacked><FieldRow label={t('Model name')}><TextInput value={form.modelName} onChange={(modelName) => setForm({ ...form, modelName })} /></FieldRow></FormRow>
          <FormRow stacked><FieldRow label={t('Enabled')}><Checkbox checked={form.isEnabled} onChange={(isEnabled) => setForm({ ...form, isEnabled })} /></FieldRow></FormRow>
          <FormRow stacked>
            <Disclosure title={t('Advanced Parameters')}>
              <FieldRow label={t('Thinking Mode')}>
                <MenuPicker value={form.thinkingMode} onChange={(thinkingMode) => setForm({ ...form, thinkingMode })} options={[{ value: '', title: t('Default') }, { value: 'enabled', title: t('Enabled') }, { value: 'disabled', title: t('Disabled') }]} />
              </FieldRow>
              <FieldRow label={t('Reasoning Effort')}>
                <MenuPicker disabled={form.thinkingMode === 'disabled'} value={form.reasoningEffort} onChange={(reasoningEffort) => setForm({ ...form, reasoningEffort })} options={[{ value: '', title: t('Default') }, { value: 'low', title: t('Low') }, { value: 'high', title: t('High') }, { value: 'max', title: t('Max') }]} />
              </FieldRow>
              <FieldRow label={t('Temperature')}><TextInput value={form.temperature} onChange={(temperature) => setForm({ ...form, temperature })} /></FieldRow>
              <FieldRow label={t('Top-P')}><TextInput value={form.topP} onChange={(topP) => setForm({ ...form, topP })} /></FieldRow>
              <FieldRow label={t('Max tokens')}><TextInput value={form.maxTokens} onChange={(maxTokens) => setForm({ ...form, maxTokens })} /></FieldRow>
            </Disclosure>
          </FormRow>
        </FormSection>
        <FormSection title={t('Actions')}>
          <FormRow stacked>
            <div className="button-row">
              <Button prominent onClick={() => void saveModel()}>{t('Save')}</Button>
              <Button onClick={() => apply(selected)}>{t('Reset')}</Button>
              <Button disabled={testing} onClick={() => void test()}>{testing ? t('Testing...') : t('Test')}</Button>
            </div>
            {selected?.lastTestedAt && <FormNote>{t('Last tested: %@', formatDate(selected.lastTestedAt, language))}</FormNote>}
            <StatusLabel message={status} />
          </FormRow>
        </FormSection>
      </div>
    </div>
  )
}

