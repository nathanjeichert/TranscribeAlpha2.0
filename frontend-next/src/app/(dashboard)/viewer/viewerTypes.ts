export type { ViewerLine, ViewerTranscript } from '@/utils/transcriptFormat'

export interface TitleCardState {
  visible: boolean
  title: string
  meta: string
  subtitle?: string
}

export type SequencePauseBehavior = 'black-screen' | 'title-card' | 'continuous'

export type SequenceState =
  | { phase: 'idle' }
  | { phase: 'title-card'; sequenceId: string; clipIndex: number }
  | { phase: 'transitioning'; sequenceId: string; clipIndex: number }
  | { phase: 'playing'; sequenceId: string; clipIndex: number }
  | { phase: 'finished'; sequenceId: string }

export type ViewerMode = 'document' | 'caption'
export type ToolsTab = 'clips' | 'sequences'
