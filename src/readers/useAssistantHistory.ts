import { useCallback, useEffect, useState } from 'react'
import type { AssistantHistoryAnchor } from '../../shared/types'

export function useAssistantHistory(paperId: string | undefined): { anchors: AssistantHistoryAnchor[]; refresh: () => void } {
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState<{ paperId: string; anchors: AssistantHistoryAnchor[] }>()
  const refresh = useCallback(() => setRevision((current) => current + 1), [])
  useEffect(() => {
    let cancelled = false
    if (paperId) void window.freddie.assistant.historyAnchors(paperId).then((anchors) => {
      if (!cancelled) setLoaded({ paperId, anchors })
    }).catch(() => {
      if (!cancelled) setLoaded({ paperId, anchors: [] })
    })
    return () => { cancelled = true }
  }, [paperId, revision])
  return { anchors: loaded?.paperId === paperId ? loaded?.anchors ?? [] : [], refresh }
}
