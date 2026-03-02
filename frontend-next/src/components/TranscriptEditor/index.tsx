'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { logger } from '@/utils/logger'
import { TranscriptEditorProps, EditorSessionResponse } from './editorTypes'

// Re-export types consumed by the editor page
export type { EditorSessionResponse, EditorSaveResponse, ClipSummary } from './editorTypes'
import { AUTO_SHIFT_STORAGE_KEY, secondsToLabel } from './editorUtils'
import { useEditorLines } from './_hooks/useEditorLines'
import { useEditorPlayer } from './_hooks/useEditorPlayer'
import { useEditorSearch } from './_hooks/useEditorSearch'
import { useEditorSave } from './_hooks/useEditorSave'
import { TranscriptRow } from './_components/TranscriptRow'
import { EditorToolbar } from './_components/EditorToolbar'
import { SpeakerRenameModal } from './_components/SpeakerRenameModal'

export default function TranscriptEditor({
  mediaKey: initialMediaKey,
  initialData,
  mediaUrl,
  mediaType,
  pdfBase64,
  xmlBase64,
  viewerHtmlBase64,
  oncueXmlEnabled = false,
  onDownload,
  buildFilename,
  onSessionChange,
  onSaveComplete,
  onRequestMediaImport,
  onOpenViewer,
  onOpenHistory,
  onGeminiRefine,
  isGeminiBusy,
  geminiError,
}: TranscriptEditorProps) {
  // ── Session meta + media key (shared by lines/save hooks) ───────────────
  const [sessionMeta, setSessionMeta] = useState<EditorSessionResponse | null>(initialData ?? null)
  const [activeMediaKey, setActiveMediaKey] = useState<string | null>(
    initialData?.media_key ?? initialMediaKey ?? null,
  )
  const [resolvedMediaUrl, setResolvedMediaUrl] = useState<string | undefined>(mediaUrl || undefined)

  // ── Stable refs for auto-save timer (avoid resetting on every edit) ─────
  const linesRef = useRef(initialData?.lines ?? [])
  const isDirtyRef = useRef(false)
  const sessionMetaRef = useRef<EditorSessionResponse | null>(initialData ?? null)

  // ── UI-only state ────────────────────────────────────────────────────────
  const [showSettings, setShowSettings] = useState(false)

  // ── Refs for virtualizer scroll management ───────────────────────────────
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)
  const programmaticScrollRef = useRef(false)
  const scrollReleaseTimerRef = useRef<number | null>(null)
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  // ── Resolved media URL sync ──────────────────────────────────────────────
  useEffect(() => {
    setResolvedMediaUrl(mediaUrl || undefined)
  }, [mediaUrl])

  // ── Derived media type ───────────────────────────────────────────────────
  const effectiveMediaType = useMemo(
    () => mediaType ?? sessionMeta?.media_content_type ?? undefined,
    [mediaType, sessionMeta],
  )

  const isVideo = useMemo(
    () => (effectiveMediaType ?? '').startsWith('video/'),
    [effectiveMediaType],
  )

  // ── Lines hook ───────────────────────────────────────────────────────────
  const lines = useEditorLines(initialData?.lines ?? [])

  // ── Keep stable refs in sync ─────────────────────────────────────────────
  useEffect(() => { linesRef.current = lines.lines }, [lines.lines])
  useEffect(() => { isDirtyRef.current = lines.isDirty }, [lines.isDirty])
  useEffect(() => { sessionMetaRef.current = sessionMeta }, [sessionMeta])

  // ── Derived values used by multiple hooks ────────────────────────────────
  const lineBoundaries = useMemo(
    () =>
      lines.lines.map((line) => {
        const start = Number.isFinite(line.start) ? line.start : 0
        const end = Number.isFinite(line.end) ? line.end : start
        return {
          id: line.id,
          start,
          end: end > start ? end : start + 0.05,
        }
      }),
    [lines.lines],
  )

  // ── Virtualizer ──────────────────────────────────────────────────────────
  const rowVirtualizer = useVirtualizer({
    count: lines.lines.length,
    getScrollElement: () => transcriptScrollRef.current,
    estimateSize: () => 56,
    overscan: 25,
  })

  const lineIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    lines.lines.forEach((line, i) => map.set(line.id, i))
    return map
  }, [lines.lines])

  const scrollVirtualToLine = useCallback(
    (lineId: string, behavior: 'smooth' | 'auto' = 'smooth') => {
      const index = lineIndexMap.get(lineId)
      if (index === undefined) return
      programmaticScrollRef.current = true
      rowVirtualizer.scrollToIndex(index, { align: 'center', behavior })
      if (scrollReleaseTimerRef.current) {
        window.clearTimeout(scrollReleaseTimerRef.current)
      }
      scrollReleaseTimerRef.current = window.setTimeout(() => {
        programmaticScrollRef.current = false
        scrollReleaseTimerRef.current = null
      }, behavior === 'smooth' ? 450 : 150)
    },
    [lineIndexMap, rowVirtualizer],
  )

  useEffect(() => {
    return () => {
      if (scrollReleaseTimerRef.current) {
        window.clearTimeout(scrollReleaseTimerRef.current)
      }
    }
  }, [])

  // ── Player hook ──────────────────────────────────────────────────────────
  const player = useEditorPlayer({
    videoRef,
    audioRef,
    resolvedMediaUrl,
    isVideo,
    lineBoundaries,
    scrollToActiveLine: scrollVirtualToLine,
  })

  // ── Search hook ──────────────────────────────────────────────────────────
  const search = useEditorSearch({
    lines: lines.lines,
    scrollToLine: scrollVirtualToLine,
    programmaticScrollRef,
    setManualScrollOverride: player.setManualScrollOverride,
  })

  // ── Save hook ────────────────────────────────────────────────────────────
  const pdfData = pdfBase64 ?? sessionMeta?.pdf_base64 ?? sessionMeta?.docx_base64 ?? ''

  const save = useEditorSave({
    activeMediaKey,
    setActiveMediaKey,
    sessionMetaRef,
    linesRef,
    isDirtyRef,
    effectiveMediaType,
    setLines: lines.setLines,
    setSessionMeta,
    setIsDirty: lines.setIsDirty,
    setEditingField: lines.setEditingField,
    resetHistory: lines.resetHistory,
    skipSyncEffectResetRef: lines.skipSyncEffectResetRef,
    materializeLinesForSave: lines.materializeLinesForSave,
    pushHistory: lines.pushHistory,
    oncueXmlEnabled,
    buildFilename,
    onDownload,
    onSessionChange,
    onSaveComplete,
    hasPendingInlineEdit: lines.hasPendingInlineEdit,
    isDirty: lines.isDirty,
    pdfData,
    xmlBase64,
    viewerHtmlBase64,
  })

  // ── Sync initialData changes (e.g., from parent page re-fetch / resync) ──
  useEffect(() => {
    if (!initialData) return
    setSessionMeta(initialData)
    lines.setLines(initialData.lines ?? [])
    const resolvedKey = initialData.media_key ?? initialMediaKey ?? null
    if (resolvedKey) setActiveMediaKey(resolvedKey)

    if (lines.skipSyncEffectResetRef.current) {
      lines.skipSyncEffectResetRef.current = false
    } else {
      lines.resetHistory()
      lines.setIsDirty(false)
    }

    player.setActiveLineId(null)
    player.setSelectedLineId(null)
    lines.setEditingField(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialData, initialMediaKey])

  // ── Inline edit focus management ─────────────────────────────────────────
  const editingLineId = lines.editingField?.lineId
  const editingFieldName = lines.editingField?.field
  useEffect(() => {
    if (!editingLineId || !editingFieldName) return
    if (editInputRef.current) {
      editInputRef.current.focus()
      if (editingFieldName === 'speaker' && 'select' in editInputRef.current) {
        ;(editInputRef.current as HTMLInputElement).select()
      }
    }
  }, [editingLineId, editingFieldName])

  // ── Auto-shift localStorage persistence ─────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem(AUTO_SHIFT_STORAGE_KEY)
      if (stored === 'true') lines.setAutoShiftNextLine(true)
      else if (stored === 'false') lines.setAutoShiftNextLine(false)
    } catch (err) {
      logger.error('Failed to load auto-shift preference:', err)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_SHIFT_STORAGE_KEY, lines.autoShiftNextLine ? 'true' : 'false')
    } catch (err) {
      logger.error('Failed to save auto-shift preference:', err)
    }
  }, [lines.autoShiftNextLine])

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  const canSave = lines.isDirty || lines.hasPendingInlineEdit

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const wantsSave = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's'
      if (wantsSave) {
        event.preventDefault()
        if (!save.saving && sessionMeta && canSave) {
          void save.handleSave()
        }
        return
      }

      if (player.isTypingInField(event.target)) return

      const mediaPlayer = isVideo ? videoRef.current : audioRef.current
      if (!mediaPlayer) return

      if (event.code === 'Space') {
        event.preventDefault()
        if (mediaPlayer.paused) {
          mediaPlayer.play().catch(() => {})
        } else {
          mediaPlayer.pause()
        }
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        mediaPlayer.currentTime = Math.max(0, mediaPlayer.currentTime - 5)
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        const nextTime = mediaPlayer.currentTime + 5
        if (Number.isFinite(mediaPlayer.duration)) {
          mediaPlayer.currentTime = Math.min(mediaPlayer.duration, nextTime)
        } else {
          mediaPlayer.currentTime = nextTime
        }
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [canSave, save, player, sessionMeta, isVideo])

  // ── Transcript scroll handler ─────────────────────────────────────────────
  const handleTranscriptScroll = useCallback(() => {
    if (!player.autoScroll || programmaticScrollRef.current || !player.activeLineId) return
    const activeIndex = lineIndexMap.get(player.activeLineId)
    if (activeIndex === undefined) return
    const virtualItems = rowVirtualizer.getVirtualItems()
    const activeVisible = virtualItems.some((item) => item.index === activeIndex)
    player.setManualScrollOverride((prev) => {
      if (!prev && !activeVisible) return true
      if (prev && activeVisible) return false
      return prev
    })
  }, [player, lineIndexMap, rowVirtualizer])

  // ── Stable row callbacks ──────────────────────────────────────────────────
  const handleRowSelect = useCallback((lineId: string) => {
    player.setSelectedLineId(lineId)
  }, [player])

  const handleRowDoubleClick = useCallback((line: Parameters<typeof player.playLine>[0]) => {
    player.playLine(line)
  }, [player])

  const handleEditingFieldChange = useCallback(
    (updater: Parameters<typeof lines.setEditingField>[0]) => {
      lines.setEditingField(updater as Parameters<typeof lines.setEditingField>[0])
    },
    [lines],
  )

  const handleAddLine = useCallback(() => {
    const newId = lines.handleAddUtterance(
      player.selectedLineId,
      player.activeLineId,
      sessionMeta?.audio_duration,
    )
    if (newId) player.setSelectedLineId(newId)
  }, [lines, player, sessionMeta])

  const handleDeleteLine = useCallback(() => {
    const nextId = lines.handleDeleteUtterance(player.selectedLineId, player.activeLineId)
    player.setSelectedLineId(nextId)
  }, [lines, player])

  const handleResync = useCallback(() => {
    void save.handleResync(lines.lines)
  }, [save, lines.lines])

  // ── Derived display values ────────────────────────────────────────────────
  const updatedLabel = sessionMeta?.updated_at
    ? new Date(sessionMeta.updated_at).toLocaleString()
    : '—'

  return (
    <div className="space-y-6 relative">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <EditorToolbar
          canUndo={lines.history.length > 0}
          canRedo={lines.future.length > 0}
          onUndo={lines.handleUndo}
          onRedo={lines.handleRedo}
          onAddLine={handleAddLine}
          onDeleteLine={handleDeleteLine}
          saving={save.saving}
          canSave={canSave}
          hasSessionMeta={!!sessionMeta}
          hasActiveMediaKey={!!activeMediaKey}
          oncueXmlEnabled={oncueXmlEnabled}
          isResyncing={save.isResyncing}
          hasResolvedMediaUrl={!!resolvedMediaUrl}
          isGeminiBusy={isGeminiBusy}
          onOpenViewer={onOpenViewer}
          onDownloadPdf={() => void save.handleDownloadPdf()}
          onDownloadViewer={() => void save.handleDownloadViewer()}
          onDownloadXml={() => void save.handleDownloadXml()}
          onShowSettings={() => setShowSettings(!showSettings)}
          showSettings={showSettings}
          onOpenHistory={onOpenHistory}
          onShowRenameModal={() => lines.setShowRenameModal(true)}
          onResync={handleResync}
          onGeminiRefine={onGeminiRefine}
          onSave={() => void save.handleSave()}
          autoScroll={player.autoScroll}
          onAutoScrollChange={player.setAutoScroll}
          autoShiftNextLine={lines.autoShiftNextLine}
          onAutoShiftChange={lines.setAutoShiftNextLine}
        />

        <div className="card-body space-y-4">
          {save.error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {save.error}
            </div>
          )}
          {geminiError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Gemini Error: {geminiError}
            </div>
          )}
          {save.snapshotError && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {save.snapshotError}
            </div>
          )}
          {(lines.addError || lines.deleteError) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {lines.addError || lines.deleteError}
            </div>
          )}
          {save.resyncError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Re-sync Error: {save.resyncError}
            </div>
          )}

          {/* Media Player */}
          {resolvedMediaUrl ? (
            <div className="rounded-xl bg-gray-900 p-3">
              {isVideo ? (
                <video
                  key={resolvedMediaUrl}
                  ref={videoRef}
                  controls
                  preload="metadata"
                  className="w-full max-h-[32vh] rounded-lg bg-black object-contain"
                  src={resolvedMediaUrl}
                />
              ) : (
                <audio
                  key={resolvedMediaUrl}
                  ref={audioRef}
                  controls
                  preload="metadata"
                  className="w-full"
                  src={resolvedMediaUrl}
                />
              )}
            </div>
          ) : (
            <div className="rounded-xl border-2 border-dashed border-gray-300 p-6 text-center">
              <svg className="w-8 h-8 mx-auto mb-2 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              <p className="text-sm text-gray-500">Import source audio/video to enable playback, clip creation, and timing correction.</p>
              {onRequestMediaImport && (
                <button
                  type="button"
                  onClick={onRequestMediaImport}
                  className="mt-4 inline-flex items-center justify-center rounded-lg bg-primary-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-primary-700"
                >
                  Import Media File
                </button>
              )}
            </div>
          )}

          <div className="rounded-xl bg-gray-50 px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-5 text-gray-600">
              <span>Lines <span className="font-medium text-gray-900">{lines.lines.length}</span></span>
              <span>Duration <span className="font-medium text-gray-900">{secondsToLabel(sessionMeta?.audio_duration ?? 0)}</span></span>
              <span>Updated <span className="font-medium text-gray-900 text-xs">{updatedLabel}</span></span>
            </div>
            <span
              className="text-xs text-primary-700 underline decoration-dotted cursor-help"
              title={'Shortcuts:\nSpace - Play/Pause\nLeft/Right - Skip 5s\nDouble-click line - Play from line'}
            >
              Shortcuts
            </span>
          </div>

          {player.showReturnToCurrent && player.activeLineId && (
            <div className="flex justify-end">
              <button
                type="button"
                className="rounded-lg border border-primary-300 bg-white px-3 py-1.5 text-xs font-medium text-primary-700 hover:bg-primary-50"
                onClick={player.handleReturnToCurrentLine}
              >
                Return to current line
              </button>
            </div>
          )}

          <div className="rounded-lg border border-primary-200 bg-white shadow-inner">
            <div className="border-b border-primary-200 px-5 py-3">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search transcript... (Ctrl+F)"
                  className="input w-full pr-20"
                  value={search.searchQuery}
                  onChange={(e) => search.performSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      search.goToSearchResult(e.shiftKey ? 'prev' : 'next')
                    } else if (e.key === 'Escape') {
                      search.clearSearch()
                    }
                  }}
                />
                {search.searchQuery && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <span className="text-xs text-primary-500">
                      {search.searchMatches.length > 0
                        ? `${search.searchCurrentIndex + 1}/${search.searchMatches.length}`
                        : '0/0'}
                    </span>
                    <button
                      type="button"
                      className="p-1 text-primary-400 hover:text-primary-600"
                      onClick={() => search.goToSearchResult('prev')}
                      title="Previous (Shift+Enter)"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="p-1 text-primary-400 hover:text-primary-600"
                      onClick={() => search.goToSearchResult('next')}
                      title="Next (Enter)"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="p-1 text-primary-400 hover:text-primary-600"
                      onClick={search.clearSearch}
                      title="Clear"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-[70px_170px_minmax(0,1fr)_140px] border-b border-primary-200 bg-primary-100 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-primary-600">
              <div>Pg:Ln</div>
              <div>Speaker</div>
              <div>Utterance</div>
              <div className="text-right">Timing</div>
            </div>

            <div
              ref={transcriptScrollRef}
              className="h-[62vh] overflow-y-auto"
              onScroll={handleTranscriptScroll}
            >
              {lines.lines.length === 0 ? (
                <div className="p-6 text-center text-primary-500">No lines available.</div>
              ) : (
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const line = lines.lines[virtualRow.index]
                    const currentSearchMatchId = search.searchMatches[search.searchCurrentIndex] ?? null
                    return (
                      <div
                        key={line.id}
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <TranscriptRow
                          line={line}
                          isActive={player.activeLineId === line.id}
                          isSelected={player.selectedLineId === line.id}
                          isSearchMatch={search.searchMatchSet.has(line.id)}
                          isCurrentSearchMatch={currentSearchMatchId === line.id}
                          editingField={
                            lines.editingField && lines.editingField.lineId === line.id
                              ? lines.editingField
                              : null
                          }
                          onSelect={handleRowSelect}
                          onDoubleClick={handleRowDoubleClick}
                          onBeginEdit={lines.beginEdit}
                          onCommitEdit={lines.commitEdit}
                          onCancelEdit={lines.cancelEdit}
                          onEditingFieldChange={handleEditingFieldChange}
                          onLineFieldChange={lines.handleLineFieldChange}
                          editInputRef={editInputRef}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <SpeakerRenameModal
        showRenameModal={lines.showRenameModal}
        renameFrom={lines.renameFrom}
        renameTo={lines.renameTo}
        renameFeedback={lines.renameFeedback}
        hasLines={lines.lines.length > 0}
        setRenameFrom={lines.setRenameFrom}
        setRenameTo={lines.setRenameTo}
        setRenameFeedback={lines.setRenameFeedback}
        setShowRenameModal={lines.setShowRenameModal}
        onRename={lines.handleRenameSpeaker}
      />

      {save.isResyncing && (
        <div className="fixed top-0 left-0 right-0 bottom-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-2xl text-center">
            <div className="mb-4 flex justify-center">
              <svg className="h-10 w-10 animate-spin text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>
            <h3 className="text-lg font-bold text-gray-900">Re-syncing Transcript</h3>
            <p className="mt-2 text-sm text-gray-600">
              Automatically re-syncing the transcript to the media file. <br />
              This could take a few minutes for longer files.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
