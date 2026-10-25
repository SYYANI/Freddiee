import type {
  BabelDocPipelineConfiguration,
  BabelDocPipelineDiagnostics,
  BabelDocProgress,
  ILDocument,
  ILTranslationContext
} from '../../BabelDocKit'

export interface BabelDocWorkerData {
  appPath: string
  pdf: Uint8Array
  pages: number[] | null
  configuration: BabelDocPipelineConfiguration
  maximumConcurrentTranslations: number
  structuredDocument?: ILDocument
}

export type BabelDocWorkerRequest =
  | { type: 'translation_result'; id: number; text: string }
  | { type: 'translation_error'; id: number; message: string }
  | { type: 'cancel' }

export type BabelDocWorkerEvent =
  | { type: 'progress'; progress: BabelDocProgress }
  | { type: 'structured_document'; document: ILDocument }
  | { type: 'translate'; id: number; text: string; context: ILTranslationContext }
  | { type: 'result'; pdf: Uint8Array; diagnostics: BabelDocPipelineDiagnostics }
  | { type: 'cancelled' }
  | { type: 'error'; message: string; stack?: string }
