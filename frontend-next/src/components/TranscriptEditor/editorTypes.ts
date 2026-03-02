import React from 'react'

export interface EditorLine {
  id: string
  speaker: string
  text: string
  rendered_text?: string
  start: number
  end: number
  page?: number | null
  line?: number | null
  pgln?: number | null
  is_continuation?: boolean
  timestamp_error?: boolean
}

export interface ClipSummary {
  clip_id: string
  name: string
  created_at: string
  duration: number
  start_time: number
  end_time: number
  start_pgln?: number | null
  end_pgln?: number | null
  start_page?: number | null
  start_line?: number | null
  end_page?: number | null
  end_line?: number | null
  media_blob_name?: string | null
  media_content_type?: string | null
  file_name?: string | null
}

export interface EditorSessionResponse {
  session_id?: string | null
  media_key?: string | null
  media_handle_id?: string | null
  media_blob_name?: string | null
  media_filename?: string | null
  media_content_type?: string | null
  title_data: Record<string, string>
  audio_duration: number
  lines_per_page: number
  lines: EditorLine[]
  created_at?: string
  updated_at?: string
  expires_at?: string
  pdf_base64?: string | null
  oncue_xml_base64?: string | null
  viewer_html_base64?: string | null
  source_turns?: unknown[]
  transcript?: string | null
  transcript_text?: string | null
  clips?: ClipSummary[]
}

export type EditorSaveResponse = EditorSessionResponse

export interface TranscriptEditorProps {
  mediaKey?: string | null
  initialData?: EditorSessionResponse | null
  mediaUrl?: string
  mediaType?: string
  pdfBase64?: string | null
  xmlBase64?: string | null
  viewerHtmlBase64?: string | null
  oncueXmlEnabled?: boolean
  onDownload: (base64Data: string, filename: string, mimeType: string) => void
  buildFilename: (baseName: string, extension: string) => string
  onSessionChange: (session: EditorSessionResponse) => void
  onSaveComplete: (result: EditorSaveResponse) => void
  onRequestMediaImport?: () => void
  onOpenViewer?: () => void
  onOpenHistory?: () => void
  onGeminiRefine?: () => void
  isGeminiBusy?: boolean
  geminiError?: string | null
}

export type EditingField = { lineId: string; field: 'speaker' | 'text'; value: string }

export interface TranscriptRowProps {
  line: EditorLine
  isActive: boolean
  isSelected: boolean
  isSearchMatch: boolean
  isCurrentSearchMatch: boolean
  editingField: EditingField | null
  onSelect: (lineId: string) => void
  onDoubleClick: (line: EditorLine) => void
  onBeginEdit: (line: EditorLine, field: 'speaker' | 'text') => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onEditingFieldChange: (updater: (prev: EditingField | null) => EditingField | null) => void
  onLineFieldChange: (lineId: string, field: keyof EditorLine, value: string | number) => void
  editInputRef: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>
}
