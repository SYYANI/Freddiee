import { useEffect, useRef } from 'react'
import { useT } from '../app/context'
import type { FindOptions, FindStatus } from '../readers/find'
import { Button, Spinner } from '../ui/controls'
import { Icon } from '../ui/Icon'

export function FindBar({ query, onQuery, options, onOptions, bilingualTarget, onBilingualTarget, status, focusToken, onNext, onPrevious, onClose }: {
  query: string
  onQuery: (query: string) => void
  options: FindOptions
  onOptions: (options: FindOptions) => void
  bilingualTarget?: 'original' | 'translated'
  onBilingualTarget?: (target: 'original' | 'translated') => void
  status?: FindStatus | null
  focusToken: number
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusToken])

  return (
    <div className="find-bar">
      {bilingualTarget && onBilingualTarget && (
        <div className="native-segmented" role="radiogroup" aria-label={t('Search In')}>
          {(['original', 'translated'] as const).map((target) => (
            <button key={target} type="button" role="radio" aria-checked={bilingualTarget === target} className={bilingualTarget === target ? 'selected' : ''} onClick={() => onBilingualTarget(target)}>
              {target === 'original' ? t('Original') : t('Translation')}
            </button>
          ))}
        </div>
      )}
      <div className="find-field field-well">
        <Icon name="magnifyingglass" size={13} className="secondary" />
        <input
          ref={input}
          value={query}
          placeholder={t('Find in Document')}
          spellCheck={false}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (event.shiftKey) onPrevious()
              else onNext()
            }
            if (event.key === 'Escape') onClose()
          }}
        />
        {status && (status.isSearching
          ? <Spinner size={11} />
          : <span className="find-status">{status.matchCount === 0 ? t('No Matches') : `${(status.currentIndex ?? -1) + 1}/${status.matchCount}`}</span>)}
        {query && (
          <button type="button" className="find-clear" title={t('Clear Search')} aria-label={t('Clear Search')} onClick={() => { onQuery(''); input.current?.focus() }}>
            <Icon name="xmark.circle.fill" size={13} />
          </button>
        )}
      </div>
      <div className="control-group">
        <button type="button" title={t('Previous Match')} aria-label={t('Previous Match')} disabled={!query} onClick={onPrevious}><Icon name="chevron.up" size={12} weight={2.2} /></button>
        <button type="button" title={t('Next Match')} aria-label={t('Next Match')} disabled={!query} onClick={onNext}><Icon name="chevron.down" size={12} weight={2.2} /></button>
      </div>
      <button type="button" className={`toggle-button ${options.matchCase ? 'on' : ''}`} title={t('Match Case')} aria-pressed={options.matchCase} onClick={() => onOptions({ ...options, matchCase: !options.matchCase })}>Aa</button>
      <button type="button" className={`toggle-button ${options.wholeWords ? 'on' : ''}`} title={t('Whole Words')} aria-pressed={options.wholeWords} onClick={() => onOptions({ ...options, wholeWords: !options.wholeWords })}><u>ab</u></button>
      <span className="spacer" />
      <Button small onClick={onClose}>{t('Done')}</Button>
    </div>
  )
}
