/** The model's page markup cannot be used as is. */
export class MarkupError extends Error {
  override name = 'MarkupError'
}

/** XeLaTeX rejected a page, or the page cannot be fitted. */
export class LatexError extends Error {
  override name = 'LatexError'
}

export type RebuildStage = 'transcribing' | 'reviewing' | 'translating' | 'typesetting'

export type RebuildErrorReason =
  /** The model's reply could not be used after three attempts. */
  | { kind: 'unusableModelOutput'; page: number; stage: RebuildStage; detail: string }
  /** The model stopped before finishing, even with the largest output budget. */
  | { kind: 'incompleteModelOutput'; label: string; finishReason: string }
  /** The input PDF cannot be opened or has no pages. */
  | { kind: 'unreadableInput' }
  /** A page image could not be rendered or stored. */
  | { kind: 'renderingFailed'; page: number }
  /** Every page failed; the first failure is attached. */
  | { kind: 'noPagesRebuilt'; firstFailure: string }
  | { kind: 'outputNotWritten' }

function describe(reason: RebuildErrorReason): string {
  switch (reason.kind) {
    case 'unusableModelOutput':
      return `page ${reason.page} ${reason.stage}: the model output is still unusable after three attempts: ${reason.detail}`
    case 'incompleteModelOutput':
      return `${reason.label}: the model output did not finish (${reason.finishReason})`
    case 'unreadableInput':
      return 'the input PDF cannot be opened'
    case 'renderingFailed':
      return `page ${reason.page} could not be rendered`
    case 'noPagesRebuilt':
      return `no page could be rebuilt: ${reason.firstFailure}`
    case 'outputNotWritten':
      return 'the rebuilt PDF could not be written'
  }
}

/** Why a rebuild page or run failed. */
export class RebuildError extends Error {
  override name = 'RebuildError'

  constructor(readonly reason: RebuildErrorReason) {
    super(describe(reason))
  }
}

/** A page that could not go through a stage; it keeps the original page in the output. */
export class PageFailure extends Error {
  override name = 'PageFailure'

  constructor(readonly stage: RebuildStage, message: string) {
    super(message)
  }
}

/**
 * Did the run stop because it was cancelled? Only the run's own signal counts: a request
 * that timed out is a page failure, like any other provider error.
 */
export function isCancellation(_error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
