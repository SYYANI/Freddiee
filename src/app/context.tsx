import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { LibrarySnapshot } from '../../shared/types'
import { createTranslator, resolveLanguage, type Translator } from '../../shared/i18n'

interface AppContextValue {
  snapshot: LibrarySnapshot
  reload: () => Promise<void>
  t: Translator
  language: 'en' | 'zh-Hans'
}

const AppContext = createContext<AppContextValue | null>(null)

/** Keeps a projection of the main-process library and reloads it whenever the library changes. */
export function AppProvider({ children, fallback }: { children: ReactNode; fallback?: ReactNode }): JSX.Element {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>()
  const reload = useCallback(async () => {
    setSnapshot(await window.freddie.library.snapshot())
  }, [])

  useEffect(() => {
    void reload()
    let scheduled = false
    return window.freddie.library.onChanged(() => {
      if (scheduled) return
      scheduled = true
      // Coalesce bursts, such as several saves from one action.
      setTimeout(() => {
        scheduled = false
        void reload()
      }, 30)
    })
  }, [reload])

  const language = resolveLanguage(snapshot?.settings.appLanguage, navigator.language)
  const t = useMemo(() => createTranslator(language), [language])

  useEffect(() => {
    document.documentElement.lang = language === 'zh-Hans' ? 'zh-CN' : 'en'
    document.documentElement.dataset.platform = window.freddie.platform
    document.documentElement.dataset.backdrop = window.freddie.backdrop
    document.documentElement.dataset.appearance = snapshot?.settings.readerAppearance ?? 'default'
  }, [language, snapshot?.settings.readerAppearance])

  if (!snapshot) return <>{fallback ?? null}</>
  return <AppContext.Provider value={{ snapshot, reload, t, language }}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp outside AppProvider')
  return value
}

export function useT(): Translator {
  return useApp().t
}

export function formatDate(value: string, language: 'en' | 'zh-Hans', options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  return new Intl.DateTimeFormat(language === 'zh-Hans' ? 'zh-CN' : 'en-US', options).format(new Date(value))
}
