import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import { currentOutlineID, type DocumentOutlineCache, type DocumentOutlineSource } from '../../shared/outline'
import { errorText } from '../app/native'

export function useDocumentOutline(paperId: string | undefined, attachmentId: string | undefined, revision: string, isHTML: boolean) {
  const [presentation, setPresentation] = useState({ paperId, value: false })
  // Close on a paper change without a follow-up effect or reopening on a later return.
  if (presentation.paperId !== paperId) setPresentation({ paperId, value: false })
  const presented = presentation.paperId === paperId && presentation.value
  const setPresented = useCallback((next: SetStateAction<boolean>) => {
    setPresentation((previous) => ({ paperId, value: typeof next === 'function' ? next(previous.paperId === paperId && previous.value) : next }))
  }, [paperId])
  const [pinned, setPinned] = useState(false)
  const [cache, setCache] = useState<DocumentOutlineCache>()
  const [busy, setBusy] = useState<'load' | 'automatic' | 'organize' | 'select'>()
  const [error, setError] = useState<string>()
  const [currentID, setCurrentID] = useState<string>()
  const location = useRef({ page: 0, fraction: 1 })
  const cacheRef = useRef(cache)
  cacheRef.current = cache
  const operation = useRef<string>()
  const identity = `${paperId}|${attachmentId}|${revision}`
  const activeIdentity = useRef<string>()
  const identityRef = useRef(identity)
  identityRef.current = identity

  const cancel = useCallback(() => {
    const id = operation.current
    operation.current = undefined
    if (id) void window.freddie.outline.cancel(id)
    setBusy(undefined)
  }, [])

  useEffect(() => {
    activeIdentity.current = identity
    cacheRef.current = undefined
    setCache(undefined); setCurrentID(undefined); setError(undefined)
    return () => { activeIdentity.current = undefined; cancel() }
  }, [identity, cancel])

  const execute = useCallback(async (action: 'load' | 'organize' | DocumentOutlineSource) => {
    if (!paperId || !attachmentId || activeIdentity.current !== identity || identityRef.current !== identity) return
    cancel()
    const id = crypto.randomUUID()
    operation.current = id
    const base = cacheRef.current
    setError(undefined)
    setBusy(action === 'load' || action === 'organize' ? action : action === 'automatic' && !base?.variants.some((variant) => variant.source === action) ? 'automatic' : 'select')
    if (base?.variants.some((variant) => variant.source === action)) {
      const next = { ...base, selectedSource: action as DocumentOutlineSource }
      setCache(next); cacheRef.current = next
      setCurrentID(currentOutlineID(next.variants.find((variant) => variant.source === action)?.entries ?? [], location.current.page, location.current.fraction))
    }
    try {
      const result = action === 'load' ? await window.freddie.outline.load(paperId, attachmentId, id)
        : action === 'organize' ? await window.freddie.outline.organize(paperId, attachmentId, id)
          : await window.freddie.outline.select(paperId, attachmentId, action, id)
      if (operation.current !== id || identityRef.current !== identity) return
      setCache(result); cacheRef.current = result
      const entries = result.variants.find((variant) => variant.source === result.selectedSource)?.entries ?? []
      setCurrentID(currentOutlineID(entries, location.current.page, location.current.fraction))
      if (action === 'automatic' && result.selectedSource !== action) setError('No reliable headings were found.')
    } catch (error) {
      if (operation.current === id && identityRef.current === identity) {
        setCache(base); cacheRef.current = base
        setError(errorText(error))
      }
    } finally {
      if (operation.current === id) { operation.current = undefined; setBusy(undefined) }
    }
  }, [paperId, attachmentId, identity, cancel])

  useEffect(() => {
    if (presented && !isHTML) void execute('load')
  }, [presented, isHTML, execute])

  const updateLocation = useCallback((page: number, fraction: number) => {
    location.current = { page, fraction }
    const current = cacheRef.current
    setCurrentID(currentOutlineID(current?.variants.find((variant) => variant.source === current.selectedSource)?.entries ?? [], page, fraction))
  }, [])

  return { presented, setPresented, pinned, setPinned, cache, busy, error, currentID, execute, cancel, updateLocation }
}
