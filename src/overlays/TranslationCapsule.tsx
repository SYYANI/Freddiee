import { useState } from 'react'
import { useT } from '../app/context'
import { Icon } from '../ui/Icon'

export type CapsulePhase = { kind: 'running'; cancelling: boolean } | { kind: 'completed' } | { kind: 'cancelled' }

const height = 40
const width = 230
const startGap = 4
const mergedFraction = 0.5

/**
 * The running translation, where toasts appear: a glow spreads across the capsule with progress,
 * and the cancel bubble at its trailing end melts into the capsule over the first half of the run.
 */
export function TranslationCapsule({ phase, detail, fraction, summary, onCancel }: {
  phase: CapsulePhase
  detail?: string
  fraction?: number
  summary?: string
  onCancel: () => void
}): JSX.Element {
  const t = useT()
  const [hovered, setHovered] = useState(false)
  const running = phase.kind === 'running'
  const cancelling = phase.kind === 'running' && phase.cancelling
  const displayed = phase.kind === 'completed' ? 1 : phase.kind === 'cancelled' ? 0 : Math.min(Math.max(fraction ?? 0, 0), 1)
  const progress = Math.min(displayed / mergedFraction, 1)
  const eased = progress * progress * (3 - 2 * progress)
  const gap = running ? startGap + (-height - startGap) * eased : -height
  const title = phase.kind === 'running' ? (cancelling ? t('Cancelling') : t('Translating')) : phase.kind === 'completed' ? t('Done') : t('Cancelled')
  const tint = phase.kind === 'completed' ? 'var(--green)' : cancelling || phase.kind === 'cancelled' ? 'var(--text-secondary)' : 'var(--accent)'
  const glow = phase.kind === 'completed' ? 'var(--green)' : 'var(--accent)'
  const fade = 40
  const capsuleWidth = width - height - gap

  return (
    <div className="translation-capsule" style={{ width, height }} title={detail}>
      <div className="capsule-shapes">
        <div className="capsule-main glass" style={{ width: capsuleWidth }} />
        <div className="capsule-bubble glass" style={{ left: capsuleWidth + gap }} />
      </div>
      <div className="capsule-glow-clip">
        <div
          className="capsule-glow"
          style={{
            width: 24 + (width + fade / 2) * displayed + fade / 2,
            background: `linear-gradient(90deg, color-mix(in srgb, ${glow} 30%, transparent) 0%, color-mix(in srgb, ${glow} 26%, transparent) calc(100% - ${fade}px), transparent 100%)`,
            opacity: cancelling ? 0.45 : 1
          }}
        />
      </div>
      <div className="capsule-content" style={{ paddingRight: 16 + Math.max(0, -gap) + height + gap }}>
        <span className="capsule-title" style={{ color: tint }}>{title}</span>
        <span className="spacer" />
        {running && summary && <span className="capsule-summary">{summary}</span>}
      </div>
      <div className="capsule-bubble-content" style={{ left: capsuleWidth + gap }}>
        {running ? (
          <button
            type="button"
            className={`capsule-cancel ${hovered && !cancelling ? 'hovered' : ''}`}
            disabled={cancelling}
            title={cancelling ? t('Cancelling translation...') : t('Cancel Translation')}
            aria-label={cancelling ? t('Cancelling translation...') : t('Cancel Translation')}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={onCancel}
          >
            <Icon name="xmark" size={14} weight={2} />
          </button>
        ) : (
          <span className="capsule-outcome" style={{ background: tint }}>
            <Icon name={phase.kind === 'completed' ? 'checkmark' : 'xmark'} size={12} weight={3} />
          </span>
        )}
      </div>
    </div>
  )
}
