import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { LibrarySnapshot } from '../../shared/types'
import { createTranslator, resolveLanguage, type Translator } from '../../shared/i18n'
import { SnapshotLoader } from './snapshotLoader'

interface AppContextValue {
  snapshot: LibrarySnapshot
  reload: () => Promise<void>
  t: Translator
  language: 'en' | 'zh-Hans'
}

const AppContext = createContext<AppContextValue | null>(null)
const TranslationContext = createContext<Translator | null>(null)

/** Keeps a projection of the main-process library and reloads it whenever the library changes. */
export function AppProvider({ children, fallback }: { children: ReactNode; fallback?: ReactNode }): JSX.Element {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>()
  const loader = useMemo(() => new SnapshotLoader((since) => window.freddie.library.snapshot(since), setSnapshot), [])
  const reload = loader.reload

  useEffect(() => {
    void reload()
    let scheduled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.freddie.library.onChanged(() => {
      if (scheduled) return
      scheduled = true
      // Coalesce bursts, such as several saves from one action.
      timer = setTimeout(() => {
        scheduled = false
        void reload()
      }, 30)
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [reload])

  const language = resolveLanguage(snapshot?.settings.appLanguage, navigator.language)
  const t = useMemo(() => createTranslator(language), [language])

  useEffect(() => {
    document.documentElement.lang = language === 'zh-Hans' ? 'zh-CN' : 'en'
    document.documentElement.dataset.platform = window.freddie.platform
    document.documentElement.dataset.backdrop = window.freddie.backdrop
    document.documentElement.dataset.appearance = snapshot?.settings.readerAppearance ?? 'default'
  }, [language, snapshot?.settings.readerAppearance])

  const value = useMemo(() => snapshot ? { snapshot, reload, t, language } : null, [snapshot, reload, t, language])
  if (!value) return <>{fallback ?? null}</>
  return <TranslationContext.Provider value={t}><AppContext.Provider value={value}>{children}</AppContext.Provider></TranslationContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp outside AppProvider')
  return value
}

export function useT(): Translator {
  const t = useContext(TranslationContext)
  if (!t) throw new Error('useT outside AppProvider')
  return t
}

export function formatDate(value: string, language: 'en' | 'zh-Hans', options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  return new Intl.DateTimeFormat(language === 'zh-Hans' ? 'zh-CN' : 'en-US', options).format(new Date(value))
}
