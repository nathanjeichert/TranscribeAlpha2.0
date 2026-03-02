'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatClock, captionTextForLine, splitSpeakerPrefix, type ViewerLine } from '@/utils/transcriptFormat'
import { routes } from '@/utils/routes'
import { guardedPush } from '@/utils/navigationGuard'
import { useViewerLoader } from './_hooks/useViewerLoader'
import { useCaseArtifacts } from './_hooks/useCaseArtifacts'
import { usePlayerSync } from './_hooks/usePlayerSync'
import { useViewerSearch } from './_hooks/useViewerSearch'
import { useClipManagement } from './_hooks/useClipManagement'
import { useSequenceManagement } from './_hooks/useSequenceManagement'
import { usePresentationMode } from './_hooks/usePresentationMode'
import { useExport } from './_hooks/useExport'
import { CaptionWindow } from './_components/CaptionWindow'
import { ClipsPanel } from './_components/ClipsPanel'
import { SequencesPanel } from './_components/SequencesPanel'
import type { ViewerMode, ToolsTab } from './viewerTypes'

const PROGRAMMATIC_SCROLL_RESET_MS = 700

export default function ViewerPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryMediaKey = searchParams.get('key')
  const queryCaseId = searchParams.get('case')
  const queryHighlightLineId = searchParams.get('highlight')

  // DOM refs — owned by the page, passed to hooks as needed
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const viewerShellRef = useRef<HTMLDivElement>(null)
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const waveformRef = useRef<HTMLDivElement>(null)

  // Local UI state
  const [viewerMode, setViewerMode] = useState<ViewerMode>('document')
  const [showToolsPanel, setShowToolsPanel] = useState(false)
  const [activeToolsTab, setActiveToolsTab] = useState<ToolsTab>('clips')

  // ─── Hooks ───────────────────────────────────────────────────────────────

  const loader = useViewerLoader({ queryMediaKey })
  const {
    transcript,
    isLoading,
    error,
    setError,
    currentMediaKey,
    mediaUrl,
    mediaAvailable,
    mediaLoading,
    mediaMissingMessage,
    mediaActionLabel,
    transcriptCacheRef,
    loadTranscriptByKey,
    getTranscriptForExport,
    relinkMedia,
    revokeMediaUrl,
  } = loader

  const isVideo = useMemo(
    () => (transcript?.media_content_type || '').startsWith('video/'),
    [transcript?.media_content_type],
  )

  const effectiveCaseId = useMemo(() => {
    if (queryCaseId) return queryCaseId
    if (transcript?.case_id && String(transcript.case_id).trim()) return String(transcript.case_id)
    return ''
  }, [queryCaseId, transcript?.case_id])

  const { clips, sequences, clipsLoading, loadCaseArtifacts } = useCaseArtifacts({ effectiveCaseId })

  const player = usePlayerSync({
    videoRef,
    audioRef,
    waveformRef,
    lineRefs,
    transcriptScrollRef,
    transcript,
    isVideo,
    mediaUrl,
  })
  const {
    currentTime,
    duration,
    setDuration,
    activeLineId,
    selectedLineId,
    setSelectedLineId,
    autoFollow,
    setAutoFollow,
    showReturnToCurrent,
    activeClipPlaybackId,
    programmaticScrollRef,
    handleTimeUpdate,
    handleLoadedMetadata,
    nearestLineFromTime,
    seekToLine,
    returnToCurrentLine,
    stopClipPlaybackLoop,
    playRange,
    waitForCanPlay,
    getPlayerElement,
  } = player

  const search = useViewerSearch({
    transcript,
    lineRefs,
    programmaticScrollRef,
    initialHighlightLineId: queryHighlightLineId,
  })
  const {
    searchQuery,
    setSearchQuery,
    searchMatches,
    searchMatchSet,
    searchCursor,
    currentSearchLineId,
    highlightLineId,
    setHighlightLineId,
    goToSearchResult,
  } = search

  const exportHook = useExport({
    transcript,
    currentMediaKey,
    transcriptCacheRef,
    getTranscriptForExport,
  })
  const {
    exporting,
    setExporting,
    exportMenuOpen,
    setExportMenuOpen,
    exportMenuRef,
    exportTranscriptPdf,
    exportStandaloneViewer,
    exportClipPdf,
    requestClipPdfBlob,
  } = exportHook

  const [clipError, setClipError] = useState('')

  const clipMgmt = useClipManagement({
    effectiveCaseId,
    clips,
    transcript,
    duration,
    currentMediaKey,
    loadCaseArtifacts,
    playRange,
    nearestLineFromTime,
    getPlayerElement,
    getTranscriptForExport,
    setExporting,
    setClipError,
    exporting,
  })
  const {
    clipName, setClipName,
    clipStart, setClipStart,
    clipEnd, setClipEnd,
    editingClip, setEditingClip,
    dragClipId, setDragClipId,
    createClip,
    startEditingClip,
    saveEditedClip,
    cancelEditingClip,
    removeClip,
    playClip,
    reorderVisibleClips,
    exportClipMedia,
  } = clipMgmt

  const presentation = usePresentationMode({
    viewerShellRef,
    clips,
    currentMediaKey,
    transcriptCacheRef,
    playRange,
    loadTranscriptByKey,
    waitForCanPlay,
  })
  const {
    presentationMode,
    titleCard,
    sequenceState,
    presentationUiVisible,
    showBlackScreen,
    waitingForResume,
    sequencePauseBehavior,
    setSequencePauseBehavior,
    clipGapSeconds,
    setClipGapSeconds,
    sequenceAbortRef,
    sequenceResumeRef,
    enterPresentationMode,
    exitPresentationMode,
    revealPresentationUi,
    clearPresentationUiTimer,
    runSequencePresentation,
  } = presentation

  const [sequenceError, setSequenceError] = useState('')

  const seqMgmt = useSequenceManagement({
    effectiveCaseId,
    clips,
    sequences,
    loadCaseArtifacts,
    getTranscriptForExport,
    requestClipPdfBlob,
    setExporting,
    exporting,
  })
  const {
    newSequenceName, setNewSequenceName,
    selectedSequenceId, setSelectedSequenceId,
    sequenceNameDrafts, setSequenceNameDrafts,
    sequenceExportStatus,
    createSequence,
    removeSequence,
    commitSequenceRename,
    addClipToSequence,
    removeSequenceEntry,
    moveSequenceEntry,
    exportSequenceZip,
  } = seqMgmt

  // ─── Derived values ───────────────────────────────────────────────────────

  const groupedPages = useMemo(() => {
    if (!transcript) return [] as Array<{ page: number; lines: ViewerLine[] }>
    const map = new Map<number, ViewerLine[]>()
    transcript.lines.forEach((line, idx) => {
      const pageNum = line.page || Math.floor(idx / transcript.lines_per_page) + 1
      if (!map.has(pageNum)) map.set(pageNum, [])
      map.get(pageNum)?.push(line)
    })
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([page, lines]) => ({ page, lines }))
  }, [transcript])

  const visibleClips = useMemo(() => {
    const sorted = [...clips].sort((a, b) => {
      const aOrder = Number.isFinite(a.order) ? Number(a.order) : Number.MAX_SAFE_INTEGER
      const bOrder = Number.isFinite(b.order) ? Number(b.order) : Number.MAX_SAFE_INTEGER
      if (aOrder !== bOrder) return aOrder - bOrder
      return (a.created_at || '').localeCompare(b.created_at || '')
    })
    if (queryCaseId) return sorted
    if (!currentMediaKey) return []
    return sorted.filter((clip) => clip.source_media_key === currentMediaKey)
  }, [clips, currentMediaKey, queryCaseId])

  const groupedVisibleClips = useMemo(() => {
    const groups = new Map<string, typeof clips>()
    visibleClips.forEach((clip) => {
      if (!groups.has(clip.source_media_key)) groups.set(clip.source_media_key, [])
      groups.get(clip.source_media_key)?.push(clip)
    })
    return Array.from(groups.entries())
  }, [visibleClips])

  const canEditClips = !!effectiveCaseId

  const activeLineIndex = useMemo(() => {
    if (!transcript || !activeLineId) return -1
    return transcript.lines.findIndex((line) => line.id === activeLineId)
  }, [activeLineId, transcript])

  const captionWindow = useMemo(() => {
    if (!transcript || activeLineIndex < 0) {
      return { prev2: '', prev1: '', current: '', next1: '', next2: '' }
    }
    const at = (index: number) => captionTextForLine(transcript.lines[index])
    return {
      prev2: at(activeLineIndex - 2),
      prev1: at(activeLineIndex - 1),
      current: at(activeLineIndex),
      next1: at(activeLineIndex + 1),
      next2: at(activeLineIndex + 2),
    }
  }, [activeLineIndex, transcript])

  // ─── Effects ──────────────────────────────────────────────────────────────

  // Reset duration when transcript changes
  useEffect(() => {
    if (transcript) {
      setDuration(transcript.audio_duration || 0)
    }
  }, [transcript, setDuration])

  // Scroll to highlighted line from case search results
  useEffect(() => {
    if (!highlightLineId || !transcript || isLoading) return
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = lineRefs.current[highlightLineId]
        if (!target) return
        programmaticScrollRef.current = true
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setSelectedLineId(highlightLineId)
        setTimeout(() => {
          programmaticScrollRef.current = false
        }, PROGRAMMATIC_SCROLL_RESET_MS)
        setTimeout(() => setHighlightLineId(null), 4000)
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [highlightLineId, isLoading, programmaticScrollRef, setHighlightLineId, setSelectedLineId, transcript])

  // Fullscreen change handler
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && presentationMode) {
        sequenceAbortRef.current = true
        stopClipPlaybackLoop()
        void exitPresentationMode()
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [exitPresentationMode, presentationMode, sequenceAbortRef, stopClipPlaybackLoop])

  // Keyboard handler
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const typingInField =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }

      if (typingInField) return

      const playerEl = getPlayerElement()
      if (!playerEl) return

      if (event.code === 'Space') {
        event.preventDefault()
        if (sequenceResumeRef.current) {
          const resume = sequenceResumeRef.current
          sequenceResumeRef.current = null
          resume()
          return
        }
        if (playerEl.paused) playerEl.play().catch(() => {})
        else playerEl.pause()
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        playerEl.currentTime = Math.max(0, playerEl.currentTime - 5)
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        const next = playerEl.currentTime + 5
        if (Number.isFinite(playerEl.duration)) playerEl.currentTime = Math.min(playerEl.duration, next)
        else playerEl.currentTime = next
        return
      }

      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        if (!presentationMode) {
          void enterPresentationMode()
        }
        return
      }

      if (event.key.toLowerCase() === 'c') {
        event.preventDefault()
        setViewerMode((prev) => (prev === 'document' ? 'caption' : 'document'))
        return
      }

      if (event.key === 'Escape' && presentationMode) {
        event.preventDefault()
        void exitPresentationMode()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enterPresentationMode, exitPresentationMode, getPlayerElement, presentationMode, sequenceResumeRef])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      revokeMediaUrl()
      stopClipPlaybackLoop()
      clearPresentationUiTimer()
      sequenceAbortRef.current = true
    }
  }, [clearPresentationUiTimer, revokeMediaUrl, sequenceAbortRef, stopClipPlaybackLoop])

  // ─── Render ───────────────────────────────────────────────────────────────

  const noTranscript = !currentMediaKey

  if (noTranscript) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center">
          <h2 className="text-xl font-semibold text-gray-900">No Transcript Selected</h2>
          <p className="mt-2 text-sm text-gray-600">Open a transcript from Cases or Recent to launch Viewer.</p>
          <Link href={routes.home()} className="btn-primary mt-6 inline-flex px-4 py-2">
            Back to Dashboard
          </Link>
        </div>
      </div>
    )
  }

  const presentationControlsVisible = !presentationMode || presentationUiVisible
  const isDocumentMode = viewerMode === 'document'
  const toolsVisible = !presentationMode && showToolsPanel

  const playerSharedProps = {
    controls: presentationControlsVisible,
    src: mediaUrl || undefined,
    onTimeUpdate: handleTimeUpdate,
    onLoadedMetadata: handleLoadedMetadata,
  }

  const mediaStatusOverlay = (
    <>
      {!mediaAvailable && (
        <div className="absolute bottom-3 left-3 right-3 rounded border border-amber-200 bg-amber-50/95 p-3 text-sm text-amber-900">
          <p className="mb-2">{mediaMissingMessage}</p>
          <button type="button" onClick={() => void relinkMedia()} className="btn-outline px-3 py-1.5 text-xs">
            {mediaActionLabel}
          </button>
        </div>
      )}
      {mediaLoading && (
        <div className="absolute right-3 top-3 rounded border border-stone-300 bg-white/95 px-2 py-1 text-xs text-stone-700">
          Loading media...
        </div>
      )}
    </>
  )

  return (
    <div ref={viewerShellRef} className="h-full bg-gradient-to-b from-blue-50/55 via-stone-100 to-stone-200 text-stone-900">
      {showBlackScreen && (
        <div
          className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-black"
          onClick={() => {
            if (sequenceResumeRef.current) {
              const resume = sequenceResumeRef.current
              sequenceResumeRef.current = null
              resume()
            }
          }}
        >
          <div className="text-sm text-white/30 select-none">Press space to continue</div>
        </div>
      )}

      {titleCard?.visible && !showBlackScreen && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/45 ${waitingForResume ? 'cursor-pointer' : 'pointer-events-none'}`}
          onClick={() => {
            if (sequenceResumeRef.current) {
              const resume = sequenceResumeRef.current
              sequenceResumeRef.current = null
              resume()
            }
          }}
        >
          <div className="rounded-xl border border-stone-300 bg-stone-50/95 px-8 py-6 text-center text-stone-900 shadow-2xl">
            <div className="text-2xl font-semibold">{titleCard.title}</div>
            <div className="mt-2 text-sm text-stone-700">{titleCard.meta}</div>
            {titleCard.subtitle && (
              <div className="mt-1 text-xs text-stone-500">{titleCard.subtitle}</div>
            )}
            {waitingForResume && (
              <div className="mt-3 text-xs text-stone-400 select-none">Press space to continue</div>
            )}
          </div>
        </div>
      )}

      {!presentationMode && (
        <div className="border-b border-blue-100 bg-white/95 px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (queryCaseId) {
                    guardedPush(router, routes.caseDetail(queryCaseId))
                  } else {
                    guardedPush(router, routes.home())
                  }
                }}
                className="btn-outline px-3 py-1.5 text-sm"
              >
                {queryCaseId ? 'Back to Case' : 'Back to Dashboard'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (currentMediaKey) guardedPush(router, routes.editor(currentMediaKey))
                }}
                className="btn-outline px-3 py-1.5 text-sm"
              >
                Edit Transcript
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center rounded-lg border border-blue-200 bg-blue-50/60 p-0.5">
                <button
                  type="button"
                  className={`rounded px-2.5 py-1 text-xs font-medium ${viewerMode === 'document' ? 'bg-blue-700 text-white shadow-sm' : 'text-blue-800 hover:bg-blue-100/80'}`}
                  onClick={() => setViewerMode('document')}
                >
                  Doc
                </button>
                <button
                  type="button"
                  className={`rounded px-2.5 py-1 text-xs font-medium ${viewerMode === 'caption' ? 'bg-blue-700 text-white shadow-sm' : 'text-blue-800 hover:bg-blue-100/80'}`}
                  onClick={() => setViewerMode('caption')}
                >
                  Caption
                </button>
              </div>

              <button
                type="button"
                className="btn-outline px-3 py-1.5 text-sm"
                onClick={() => setShowToolsPanel((prev) => !prev)}
              >
                {showToolsPanel ? 'Hide Tools' : 'Show Tools'}
              </button>

              <button
                type="button"
                className="rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-900 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={exportTranscriptPdf}
                disabled={!transcript?.pdf_base64}
                title={transcript?.pdf_base64 ? 'Download transcript PDF' : 'PDF is not available for this transcript'}
              >
                Download PDF
              </button>

              <div ref={exportMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setExportMenuOpen((open) => !open)}
                  className="btn-outline px-3 py-1.5 text-sm"
                >
                  Export
                </button>
                {exportMenuOpen && (
                  <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
                    <button
                      type="button"
                      className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-gray-50"
                      onClick={() => {
                        setExportMenuOpen(false)
                        exportTranscriptPdf()
                      }}
                      disabled={!transcript?.pdf_base64}
                    >
                      Download PDF
                    </button>
                    <button
                      type="button"
                      className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-gray-50"
                      onClick={() => {
                        setExportMenuOpen(false)
                        void exportStandaloneViewer(setError)
                      }}
                    >
                      Standalone HTML (Embedded Media)
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  void enterPresentationMode()
                }}
                className="btn-primary px-3 py-1.5 text-sm"
              >
                Present
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      )}

      <div className={`min-h-0 ${presentationMode ? 'h-screen' : 'h-[calc(100vh-74px)]'}`}>
        <div className={`grid h-full min-h-0 ${toolsVisible ? 'grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]' : 'grid-cols-1'}`}>
          <div className={`grid h-full min-h-0 ${isDocumentMode ? 'grid-cols-1 xl:grid-cols-[minmax(340px,44%)_minmax(0,1fr)]' : 'grid-cols-1'}`}>
            <section
              className="relative flex min-h-0 flex-col bg-stone-100"
              onMouseMove={() => {
                if (presentationMode) revealPresentationUi()
              }}
              onMouseLeave={() => {
                if (presentationMode) {
                  clearPresentationUiTimer()
                }
              }}
            >
              {presentationMode && (
                <div
                  onMouseEnter={revealPresentationUi}
                  onMouseMove={revealPresentationUi}
                  className={`absolute right-4 top-4 z-30 flex items-center gap-2 transition-opacity duration-200 ${
                    presentationControlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
                  }`}
                >
                  <div className="flex items-center rounded border border-blue-200 bg-white/95 p-0.5 shadow-sm">
                    <button
                      type="button"
                      className={`rounded px-2.5 py-1 text-xs font-medium ${viewerMode === 'document' ? 'bg-blue-700 text-white' : 'text-blue-800 hover:bg-blue-100/80'}`}
                      onClick={() => setViewerMode('document')}
                    >
                      Doc
                    </button>
                    <button
                      type="button"
                      className={`rounded px-2.5 py-1 text-xs font-medium ${viewerMode === 'caption' ? 'bg-blue-700 text-white' : 'text-blue-800 hover:bg-blue-100/80'}`}
                      onClick={() => setViewerMode('caption')}
                    >
                      Caption
                    </button>
                  </div>
                  <button
                    type="button"
                    className="rounded border border-stone-300 bg-white/95 px-3 py-1.5 text-sm text-stone-800 shadow-sm hover:bg-stone-100"
                    onClick={() => void exitPresentationMode()}
                  >
                    Exit
                  </button>
                </div>
              )}

              {!presentationMode && (
                <div className="border-b border-blue-100 bg-white/95 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-medium text-stone-900">
                      {transcript?.title_data?.CASE_NAME || transcript?.title_data?.FILE_NAME || transcript?.media_key}
                    </div>
                    <div className="text-xs font-medium text-blue-800/80">
                      {formatClock(currentTime)} / {formatClock(duration || transcript?.audio_duration || 0)}
                    </div>
                  </div>
                </div>
              )}

              <div className="min-h-0 flex-1 p-3">
                {isVideo ? (
                  <div className={viewerMode === 'caption' ? 'flex h-full min-h-0 flex-col gap-3' : 'relative h-full'}>
                    <div className={viewerMode === 'caption' ? 'relative min-h-0 flex-1 rounded-xl border border-blue-200 bg-white' : 'h-full rounded-xl border border-stone-300 bg-stone-50'}>
                      <video
                        ref={videoRef}
                        {...playerSharedProps}
                        className="h-full w-full rounded-xl bg-black object-contain"
                      />
                      {mediaStatusOverlay}
                    </div>
                    {viewerMode === 'caption' && <CaptionWindow captionWindow={captionWindow} />}
                  </div>
                ) : (
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <audio
                      ref={audioRef}
                      {...playerSharedProps}
                      className="w-full shrink-0"
                    />
                    <div className="relative min-h-0 flex-1 rounded-xl overflow-hidden bg-gradient-to-b from-slate-800 to-slate-900">
                      <div className="absolute inset-0 flex items-center px-6">
                        <div ref={waveformRef} className="w-full" />
                      </div>
                      {mediaStatusOverlay}
                    </div>
                    {viewerMode === 'caption' && <CaptionWindow captionWindow={captionWindow} />}
                  </div>
                )}
              </div>
            </section>

            {isDocumentMode && (
              <section className="relative flex min-h-0 flex-col bg-gradient-to-b from-blue-50/35 to-stone-100 text-stone-900">
                {!presentationMode && (
                  <div className="px-4 pb-2 pt-3">
                    <div className="rounded-xl border border-blue-100 bg-white p-2 shadow-sm">
                      <div className="flex items-center gap-2">
                        <input
                          ref={searchInputRef}
                          className="h-9 flex-1 rounded border border-blue-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-500 focus:border-blue-400 focus:outline-none"
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              goToSearchResult(event.shiftKey ? -1 : 1)
                            }
                          }}
                          placeholder="Search transcript"
                        />
                        <button type="button" className="btn-outline border-blue-200 px-2 py-1 text-xs text-blue-800 hover:bg-blue-50" onClick={() => goToSearchResult(-1)} disabled={!searchMatches.length}>
                          Prev
                        </button>
                        <button type="button" className="btn-outline border-blue-200 px-2 py-1 text-xs text-blue-800 hover:bg-blue-50" onClick={() => goToSearchResult(1)} disabled={!searchMatches.length}>
                          Next
                        </button>
                        <span className="min-w-[54px] text-right text-xs text-blue-700/80">
                          {searchMatches.length ? `${((searchCursor % searchMatches.length) + searchMatches.length) % searchMatches.length + 1}/${searchMatches.length}` : '0/0'}
                        </span>
                      </div>
                      <div className="mt-1.5 text-[11px] text-blue-700/75">
                        Single-click selects a line. Double-click starts playback from that line.
                      </div>
                    </div>
                  </div>
                )}

                <div ref={transcriptScrollRef} className="flex-1 overflow-y-auto px-4 pb-6">
                  {showReturnToCurrent && activeLineId && (
                    <div className="sticky top-2 z-20 mb-2 flex justify-end">
                      <button type="button" className="rounded border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-800" onClick={returnToCurrentLine}>
                        Return to current line
                      </button>
                    </div>
                  )}

                  {isLoading ? (
                    <div className="rounded-xl border border-blue-100 bg-white px-4 py-6 text-sm text-stone-600">
                      Loading transcript...
                    </div>
                  ) : groupedPages.length === 0 ? (
                    <div className="rounded-xl border border-blue-100 bg-white px-4 py-6 text-sm text-stone-600">
                      No transcript lines available.
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {groupedPages.map((pageBlock) => (
                        <div
                          key={pageBlock.page}
                          className="relative mx-auto w-full max-w-[8.5in] bg-white shadow-[0_4px_24px_rgba(15,23,42,0.12)]"
                          style={{ padding: '24px' }}
                        >
                          <div
                            className="absolute inset-0 border border-stone-400 pointer-events-none"
                            style={{ margin: '8px' }}
                          />
                          <div
                            className="absolute inset-0 border border-stone-400 pointer-events-none"
                            style={{ margin: '12px' }}
                          />

                          <div
                            className="relative font-mono"
                            style={{ fontFamily: '"Courier New", Courier, monospace' }}
                          >
                            <div>
                              {pageBlock.lines.map((line) => {
                                const active = activeLineId === line.id
                                const selected = selectedLineId === line.id
                                const match = searchMatchSet.has(line.id)
                                const currentMatch = currentSearchLineId === line.id
                                const lineDisplay = splitSpeakerPrefix(line)
                                const highlighted = highlightLineId === line.id

                                const lineClasses = [
                                  'group grid cursor-pointer grid-cols-[36px_minmax(0,1fr)] gap-2 px-1 font-mono text-[12pt] leading-[2] text-stone-900 transition-colors hover:bg-blue-50/30',
                                  active ? 'bg-amber-100/80' : '',
                                  selected && !highlighted ? 'ring-1 ring-inset ring-blue-400 bg-blue-50/70' : '',
                                  match ? 'bg-amber-50' : '',
                                  currentMatch ? 'outline outline-1 outline-amber-400' : '',
                                  highlighted ? 'ring-2 ring-inset ring-yellow-400 bg-yellow-100 animate-pulse' : '',
                                ]

                                return (
                                  <div
                                    key={line.id}
                                    ref={(node) => {
                                      lineRefs.current[line.id] = node
                                    }}
                                    className={lineClasses.join(' ')}
                                    onClick={() => {
                                      setSelectedLineId(line.id)
                                    }}
                                    onDoubleClick={() => {
                                      setSelectedLineId(line.id)
                                      seekToLine(line, true)
                                    }}
                                  >
                                    <div className="pt-0.5 text-right text-[10px] tabular-nums text-stone-400 select-none">
                                      {line.line || '-'}
                                    </div>
                                    <div className="whitespace-pre-wrap break-words">
                                      {lineDisplay.speakerLabel ? (
                                        <>
                                          {lineDisplay.leading}
                                          <span className="font-bold text-stone-900">
                                            {lineDisplay.speakerLabel}
                                          </span>
                                          {lineDisplay.trailing}
                                        </>
                                      ) : (
                                        lineDisplay.lineText || line.text
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>

                            <div className="mt-2 text-center text-[10px] font-mono tabular-nums text-stone-500 select-none">
                              {pageBlock.page}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>

          {toolsVisible && (
            <aside className="flex h-full min-h-0 flex-col border-l border-blue-100 bg-gradient-to-b from-white to-blue-50/35">
              <div className="border-b border-blue-100 px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-gray-900">Tools</div>
                  <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => setShowToolsPanel(false)}>
                    Hide
                  </button>
                </div>
                <div className="mt-3 flex items-center rounded-lg border border-blue-200 bg-blue-50/60 p-0.5">
                  <button
                    type="button"
                    className={`flex-1 rounded px-2.5 py-1.5 text-xs font-medium ${activeToolsTab === 'clips' ? 'bg-blue-700 text-white shadow-sm' : 'text-blue-800 hover:bg-blue-100/80'}`}
                    onClick={() => setActiveToolsTab('clips')}
                  >
                    Clips
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded px-2.5 py-1.5 text-xs font-medium ${activeToolsTab === 'sequences' ? 'bg-blue-700 text-white shadow-sm' : 'text-blue-800 hover:bg-blue-100/80'}`}
                    onClick={() => setActiveToolsTab('sequences')}
                  >
                    Sequences
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {activeToolsTab === 'clips' ? (
                  <ClipsPanel
                    transcript={transcript}
                    selectedLineId={selectedLineId}
                    clips={clips}
                    clipsLoading={clipsLoading}
                    canEditClips={canEditClips}
                    exporting={exporting}
                    queryCaseId={queryCaseId}
                    currentMediaKey={currentMediaKey}
                    activeClipPlaybackId={activeClipPlaybackId}
                    clipName={clipName}
                    setClipName={setClipName}
                    clipStart={clipStart}
                    setClipStart={setClipStart}
                    clipEnd={clipEnd}
                    setClipEnd={setClipEnd}
                    clipError={clipError}
                    editingClip={editingClip}
                    setEditingClip={setEditingClip}
                    dragClipId={dragClipId}
                    setDragClipId={setDragClipId}
                    groupedVisibleClips={groupedVisibleClips}
                    onCreateClip={() => void createClip()}
                    onStartEditingClip={startEditingClip}
                    onSaveEditedClip={() => void saveEditedClip()}
                    onCancelEditingClip={cancelEditingClip}
                    onRemoveClip={(clip) => void removeClip(clip)}
                    onPlayClip={(clip) => void playClip(clip)}
                    onReorderVisibleClips={(sourceId, targetId) => void reorderVisibleClips(sourceId, targetId, visibleClips)}
                    onExportClipPdf={(clip) => void exportClipPdf(clip, setClipError)}
                    onExportClipMedia={(clip) => void exportClipMedia(clip)}
                  />
                ) : (
                  <SequencesPanel
                    clips={clips}
                    sequences={sequences}
                    canEditClips={canEditClips}
                    exporting={exporting}
                    sequencePauseBehavior={sequencePauseBehavior}
                    setSequencePauseBehavior={setSequencePauseBehavior}
                    clipGapSeconds={clipGapSeconds}
                    setClipGapSeconds={setClipGapSeconds}
                    sequenceState={sequenceState}
                    newSequenceName={newSequenceName}
                    setNewSequenceName={setNewSequenceName}
                    selectedSequenceId={selectedSequenceId}
                    setSelectedSequenceId={setSelectedSequenceId}
                    sequenceNameDrafts={sequenceNameDrafts}
                    setSequenceNameDrafts={setSequenceNameDrafts}
                    sequenceError={sequenceError}
                    sequenceExportStatus={sequenceExportStatus}
                    onCreateSequence={() => void createSequence()}
                    onRemoveSequence={(seq) => void removeSequence(seq)}
                    onCommitSequenceRename={(seq) => void commitSequenceRename(seq)}
                    onAddClipToSequence={(seq, clipId) => void addClipToSequence(seq, clipId)}
                    onRemoveSequenceEntry={(seq, idx) => void removeSequenceEntry(seq, idx)}
                    onMoveSequenceEntry={(seq, from, to) => void moveSequenceEntry(seq, from, to)}
                    onRunSequencePresentation={async (seq) => {
                      setSequenceError('')
                      if (!seq.entries.length) {
                        setSequenceError('Select clips before presenting this sequence.')
                        return
                      }
                      try {
                        await runSequencePresentation(seq)
                      } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : 'Sequence presentation failed'
                        setSequenceError(message)
                      }
                    }}
                    onExportSequenceZip={(seq) => void exportSequenceZip(seq)}
                  />
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
