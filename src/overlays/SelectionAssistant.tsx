import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AssistantConversation, AssistantSource, AssistantTurn, NoteSelectionContext, SelectionAssistantAction } from '../../shared/types'
import { useT } from '../app/context'
import { errorText, popupMenu } from '../app/native'
import { Icon } from '../ui/Icon'
import { NoteMarkdown } from '../ui/NoteMarkdown'
import { Spinner } from '../ui/controls'

export function selectionIdentity(selection: NoteSelectionContext): string {
  const quote = selection.quote.split(/\s+/).filter(Boolean).join(' ')
  return [selection.attachmentId ?? '', selection.pageIndex ?? '', selection.htmlSelector ?? '', quote.slice(0, 400)].join('|')
}

export function SelectionAssistant({ paperId, selection, conversationIdentity, onConversationSaved, onInteraction, onDismiss, onSaveNote, onQuoteInWriting, onSourceActivated }: {
  paperId: string
  selection: NoteSelectionContext
  conversationIdentity?: string
  onConversationSaved?: () => void
  onInteraction: () => void
  onDismiss: () => void
  onSaveNote: (selection: NoteSelectionContext, markdown: string, existingNoteId?: string) => Promise<string>
  onQuoteInWriting?: (selection: NoteSelectionContext, citeOnly: boolean) => void
  onSourceActivated: (source: AssistantSource) => void
}): JSX.Element {
  const t = useT()
  const identity = conversationIdentity ?? selectionIdentity(selection)
  const [action, setAction] = useState<SelectionAssistantAction | null>(null)
  const [enteringQuestion, setEnteringQuestion] = useState(false)
  const [question, setQuestion] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [turns, setTurns] = useState<AssistantTurn[]>([])
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null)
  const [partial, setPartial] = useState('')
  const [progress, setProgress] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const [savedNoteId, setSavedNoteId] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const requestId = useRef<string>()
  const restoreGeneration = useRef(0)
  const questionField = useRef<HTMLInputElement>(null)
  const conversationEnd = useRef<HTMLDivElement>(null)

  // Restore the conversation saved for this selection.
  useEffect(() => {
    setAction(null)
    setTurns([])
    setPartial('')
    setError(undefined)
    setSaved(false)
    setSavedNoteId(undefined)
    setEnteringQuestion(false)
    setWorking(false)
    setPendingQuestion(null)
    requestId.current = undefined
    const generation = ++restoreGeneration.current
    let cancelled = false
    void window.freddie.assistant.conversation(paperId, identity).then((conversation) => {
      if (cancelled || generation !== restoreGeneration.current || !conversation) return
      setAction(conversation.action)
      setTurns(conversation.turns)
      setSavedNoteId(conversation.savedNoteId)
      setSaved(Boolean(conversation.savedNoteId))
    }).catch((reason: unknown) => {
      if (!cancelled && generation === restoreGeneration.current) setError(errorText(reason))
    })
    return () => {
      cancelled = true
      if (requestId.current) void window.freddie.assistant.stop(requestId.current)
      requestId.current = undefined
    }
  }, [paperId, identity])

  useEffect(() => window.freddie.assistant.onEvent((event) => {
    if (event.requestId !== requestId.current) return
    if (event.type === 'progress') setProgress(event.text ?? '')
    if (event.type === 'partial') setPartial(event.text ?? '')
    if (event.type === 'error') {
      setError(event.text)
      setWorking(false)
      setPendingQuestion(null)
      setPartial('')
    }
    if (event.type === 'done') {
      requestId.current = undefined
      setWorking(false)
      setPartial('')
      const next = [...turns, { question: pendingQuestion ?? '', answer: event.text ?? '', sources: event.sources ?? [] }]
      setTurns(next)
      persist(next)
      setPendingQuestion(null)
    }
  }), [paperId, identity, pendingQuestion, action, savedNoteId, turns])

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: 'end' })
  }, [turns.length, partial, pendingQuestion])

  const persist = (next: AssistantTurn[], noteId = savedNoteId): void => {
    if (!action) return
    const conversation: AssistantConversation = { selectionIdentity: identity, action, selection: { ...selection, rect: undefined }, turns: next, savedNoteId: noteId, modifiedAt: new Date().toISOString() }
    const generation = restoreGeneration.current
    void window.freddie.assistant.saveConversation(paperId, conversation).then(() => onConversationSaved?.()).catch((reason: unknown) => {
      if (generation === restoreGeneration.current) setError(errorText(reason))
    })
  }

  const run = (nextAction: SelectionAssistantAction, nextQuestion: string | null, history: AssistantTurn[]): void => {
    ++restoreGeneration.current
    onInteraction()
    setAction(nextAction)
    setError(undefined)
    setWorking(true)
    setSaved(false)
    setPendingQuestion(nextQuestion ?? (history.length ? null : ''))
    setProgress(t('Collecting paper context...'))
    const id = crypto.randomUUID()
    requestId.current = id
    void window.freddie.assistant.run({
      requestId: id,
      paperId,
      action: nextAction,
      selection: { ...selection, rect: undefined },
      question: nextQuestion ?? undefined,
      conversation: history
    }).catch((reason: unknown) => {
      if (requestId.current !== id) return
      setError(errorText(reason))
      setWorking(false)
    })
  }

  const start = (nextAction: SelectionAssistantAction): void => {
    if (nextAction === 'ask') {
      onInteraction()
      setEnteringQuestion(true)
      setTimeout(() => questionField.current?.focus(), 0)
      return
    }
    setTurns([])
    run(nextAction, null, [])
  }

  const submitQuestion = (): void => {
    const value = question.trim()
    if (!value || working) return
    setEnteringQuestion(false)
    setQuestion('')
    setTurns([])
    run('ask', value, [])
  }

  const submitFollowUp = (value = followUp.trim()): void => {
    if (!value || working || !action) return
    setFollowUp('')
    run(action, value, turns)
  }

  const stop = (): void => {
    if (requestId.current) void window.freddie.assistant.stop(requestId.current)
  }

  const markdown = (): string => turns.map((turn, index) => {
    const parts: string[] = []
    if (turn.question) parts.push(`**${turn.question}**`)
    parts.push(turn.answer)
    const sources = turn.sources.filter((source) => source.kind !== 'currentSelection')
    if (sources.length) parts.push(`### ${t('Sources')}\n${sources.map((source, sourceIndex) => `- [S${sourceIndex + 1}] ${source.urlString ? `[${source.title}](${source.urlString})` : source.title}`).join('\n')}`)
    return (index > 0 ? '---\n\n' : '') + parts.join('\n\n')
  }).join('\n\n')

  const saveAsNote = async (): Promise<void> => {
    onInteraction()
    try {
      const noteId = await onSaveNote(selection, markdown(), savedNoteId)
      setSavedNoteId(noteId)
      setSaved(true)
      persist(turns, noteId)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const resultTitle = action === 'translate' ? t('Translation') : action === 'explain' ? t('AI Explanation') : t('Ask AI')
  const tint = action === 'translate' ? 'var(--orange)' : 'var(--accent)'

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>, corner: 'tl' | 'tr'): void => {
    event.preventDefault()
    event.stopPropagation()
    onInteraction()
    const card = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const move = (pointer: PointerEvent): void => {
      const dx = (pointer.clientX - startX) * (corner === 'tl' ? -2 : 2)
      setSize({ width: Math.min(Math.max(card.width + dx, 360), window.innerWidth - 120), height: Math.min(Math.max(card.height - (pointer.clientY - startY), 180), window.innerHeight - 220) })
    }
    const stopResize = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stopResize)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stopResize)
  }

  return (
    <div className="selection-assistant" onPointerDown={onInteraction}>
      {action && (
        <div className="assistant-card assistant-material" style={size ? { width: size.width, height: size.height } : undefined}>
          <div className="resize-corner tl" onPointerDown={(event) => beginResize(event, 'tl')} title={t('Resize AI window')} />
          <div className="resize-corner tr" onPointerDown={(event) => beginResize(event, 'tr')} title={t('Resize AI window')} />
          <div className="assistant-header" style={{ color: tint }}>
            <Icon name={action === 'translate' ? 'translate' : 'sparkles'} size={15} />
            <strong>{resultTitle}</strong>
            <span className="spacer" />
            {turns.length > 0 && (
              <>
                <button type="button" className="assistant-text-button" disabled={saved} onClick={() => void saveAsNote()}>
                  <Icon name={saved ? 'checkmark.circle.fill' : 'note.text.badge.plus'} size={13} />
                  {saved ? t('Saved to Notes') : t('Save as Note')}
                </button>
                <button type="button" className="plain-icon" title={t('Copy')} aria-label={t('Copy')} onClick={() => void window.freddie.shell.copyText(markdown())}>
                  <Icon name="doc.on.doc" size={14} />
                </button>
              </>
            )}
            {working && (
              <button type="button" className="plain-icon" title={t('Stop Generating')} aria-label={t('Stop Generating')} onClick={stop}>
                <Icon name="stop.circle.fill" size={15} />
              </button>
            )}
            <button type="button" className="plain-icon" title={t('Close')} aria-label={t('Close')} onClick={() => { stop(); setAction(null); setTurns([]) }}>
              <Icon name="xmark" size={14} />
            </button>
          </div>
          <div className="assistant-conversation">
            {turns.map((turn, index) => (
              <div key={index} className="assistant-turn">
                {turn.question && (action === 'ask' || index > 0) && <div className="assistant-question">{turn.question}</div>}
                <NoteMarkdown markdown={turn.answer} className="assistant-answer" />
                <SourceChips sources={turn.sources} onActivate={onSourceActivated} />
              </div>
            ))}
            {working && (
              <div className="assistant-turn">
                {pendingQuestion && <div className="assistant-question">{pendingQuestion}</div>}
                {partial ? <NoteMarkdown markdown={partial} className="assistant-answer" /> : (
                  <div className="assistant-progress"><Spinner size={12} />{progress}</div>
                )}
              </div>
            )}
            {error && <div className="assistant-error">{error}</div>}
            <div ref={conversationEnd} />
          </div>
          {turns.length > 0 && (
            <div className="assistant-follow-up">
              <input
                value={followUp}
                placeholder={t('Ask a follow-up...')}
                onChange={(event) => setFollowUp(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitFollowUp()
                }}
              />
              <button type="button" className="plain-icon accent" disabled={!followUp.trim() || working} title={t('Send Follow-up')} aria-label={t('Send Follow-up')} onClick={() => submitFollowUp()}>
                <Icon name="arrow.up.circle.fill" size={19} />
              </button>
              <button
                type="button"
                className="plain-icon"
                aria-label={t('More')}
                onClick={async (event) => {
                  const choice = await popupMenu([
                    { id: 'regenerate', label: t('Regenerate'), enabled: !working },
                    { id: 'shorten', label: t('Shorten the answer'), enabled: !working },
                    { id: 'expand', label: t('Expand the background'), enabled: !working }
                  ], event.currentTarget)
                  if (choice === 'regenerate' && action) {
                    const previous = turns.slice(0, -1)
                    const last = turns[turns.length - 1]
                    setTurns(previous)
                    run(action, last?.question || null, previous)
                  }
                  if (choice === 'shorten') submitFollowUp('Make the preceding answer shorter while preserving its evidence and caveats.')
                  if (choice === 'expand') submitFollowUp('Expand the essential background, keeping paper claims distinct from general knowledge.')
                }}
              >
                <Icon name="ellipsis.circle" size={16} />
              </button>
            </div>
          )}
        </div>
      )}
      {enteringQuestion ? (
        <div className="assistant-question-field assistant-material">
          <input
            ref={questionField}
            value={question}
            placeholder={t('Ask about the selected text...')}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitQuestion()
              if (event.key === 'Escape') setEnteringQuestion(false)
            }}
          />
          <button type="button" className="plain-icon" disabled={!question.trim() || working} title={t('Send Question')} aria-label={t('Send Question')} onClick={submitQuestion}>
            <Icon name="bubble.left" size={17} />
          </button>
        </div>
      ) : (
        <div className="assistant-actions assistant-material">
          <CircleButton icon="sparkles" title={t('Explain Selected Text')} disabled={working} onClick={() => start('explain')} />
          <CircleButton icon="bubble.left" title={t('Ask AI About Selected Text')} disabled={working} onClick={() => start('ask')} />
          <CircleButton icon="translate" title={t('Translate Selected Text')} disabled={working} onClick={() => start('translate')} />
          {onQuoteInWriting && (
            <>
              <span className="assistant-divider" />
              <CircleButton icon="text.quote" title={t('Quote in Writing (Option-click to add only the citation)')} onClick={(event) => onQuoteInWriting(selection, event.altKey)} />
            </>
          )}
          <button type="button" className="assistant-dismiss" aria-label={t('Close')} onClick={onDismiss} hidden />
        </div>
      )}
    </div>
  )
}

function CircleButton({ icon, title, disabled, onClick }: { icon: string; title: string; disabled?: boolean; onClick: (event: React.MouseEvent) => void }): JSX.Element {
  return (
    <button type="button" className="circle-button" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={16} weight={1.9} />
    </button>
  )
}

function SourceChips({ sources, onActivate }: { sources: AssistantSource[]; onActivate: (source: AssistantSource) => void }): JSX.Element | null {
  const t = useT()
  const shown = sources.filter((source) => source.kind !== 'currentSelection')
  if (!shown.length) return null
  return (
    <div className="assistant-sources">
      <span className="assistant-sources-title">{t('Sources')}</span>
      <div className="assistant-source-list">
        {shown.map((source, index) => (
          <button key={source.id} type="button" className="source-chip" title={source.excerpt.slice(0, 300)} onClick={() => onActivate(source)}>
            <Icon name={source.kind === 'external' ? 'globe' : source.pageIndex !== undefined ? 'bookmark' : 'doc.text'} size={11} />
            S{index + 1} · {source.pageIndex !== undefined ? `${t('Page')} ${source.pageIndex + 1}` : source.title.slice(0, 40)}
          </button>
        ))}
      </div>
    </div>
  )
}
