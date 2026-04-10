import { formatClock, formatRange, type ViewerTranscript } from '@/utils/transcriptFormat'
import type { ClipRecord } from '@/lib/storage'
import type { ClipDraft } from '../viewerTypes'

interface EditingClip {
  id: string
  name: string
  start: string
  end: string
}

interface ClipsPanelProps {
  transcript: ViewerTranscript | null
  selectedLineId: string | null
  clips: ClipRecord[]
  clipsLoading: boolean
  canEditClips: boolean
  exporting: boolean
  queryCaseId: string | null
  currentMediaKey: string | null
  activeClipPlaybackId: string | null
  clipAssistantPrompt: string
  setClipAssistantPrompt: (v: string) => void
  clipAssistantBusy: boolean
  clipAssistantError: string
  clipDraft: ClipDraft | null
  clipName: string
  setClipName: (v: string) => void
  clipStart: string
  setClipStart: (v: string) => void
  clipEnd: string
  setClipEnd: (v: string) => void
  clipError: string
  editingClip: EditingClip | null
  setEditingClip: (clip: EditingClip | null) => void
  dragClipId: string | null
  setDragClipId: (id: string | null) => void
  groupedVisibleClips: [string, ClipRecord[]][]
  onRunClipAssistant: () => void
  onPreviewDraft: () => void
  onSaveDraft: () => void
  onExportDraftPdf: () => void
  onExportDraftMedia: () => void
  onClearDraft: () => void
  onCreateClip: () => void
  onStartEditingClip: (clip: ClipRecord) => void
  onSaveEditedClip: () => void
  onCancelEditingClip: () => void
  onRemoveClip: (clip: ClipRecord) => void
  onPlayClip: (clip: ClipRecord) => void
  onReorderVisibleClips: (sourceId: string, targetId: string) => void
  onExportClipPdf: (clip: ClipRecord) => void
  onExportClipMedia: (clip: ClipRecord) => void
}

export function ClipsPanel({
  transcript,
  selectedLineId,
  clips,
  clipsLoading,
  canEditClips,
  exporting,
  queryCaseId,
  currentMediaKey,
  activeClipPlaybackId,
  clipAssistantPrompt,
  setClipAssistantPrompt,
  clipAssistantBusy,
  clipAssistantError,
  clipDraft,
  clipName,
  setClipName,
  clipStart,
  setClipStart,
  clipEnd,
  setClipEnd,
  clipError,
  editingClip,
  setEditingClip,
  dragClipId,
  setDragClipId,
  groupedVisibleClips,
  onRunClipAssistant,
  onPreviewDraft,
  onSaveDraft,
  onExportDraftPdf,
  onExportDraftMedia,
  onClearDraft,
  onCreateClip,
  onStartEditingClip,
  onSaveEditedClip,
  onCancelEditingClip,
  onRemoveClip,
  onPlayClip,
  onReorderVisibleClips,
  onExportClipPdf,
  onExportClipMedia,
}: ClipsPanelProps) {
  const hasTranscript = Boolean(transcript)

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-950">Clip Assistant</h3>
            <p className="mt-0.5 text-xs text-gray-600">Draft one editable clip from plain language.</p>
          </div>
          {clipAssistantBusy && <span className="text-xs font-medium text-blue-700">Drafting...</span>}
        </div>

        <div className="mt-3 space-y-3 rounded-lg border border-blue-200 bg-white p-3 shadow-sm">
          <textarea
            value={clipAssistantPrompt}
            onChange={(event) => setClipAssistantPrompt(event.target.value)}
            className="min-h-[92px] w-full resize-y rounded border border-blue-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 focus:border-blue-400 focus:outline-none"
            placeholder={'Try "clip from page five to page nine" or "clip the part where he talks about the knife"'}
            disabled={!hasTranscript || clipAssistantBusy}
          />
          <button
            type="button"
            className="btn-primary w-full px-3 py-2 text-sm"
            disabled={!hasTranscript || clipAssistantBusy || !clipAssistantPrompt.trim()}
            onClick={() => void onRunClipAssistant()}
          >
            Draft Clip
          </button>

          {clipAssistantError && (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {clipAssistantError}
            </div>
          )}

          {clipDraft && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-emerald-950">{clipDraft.name}</div>
                  <div className="mt-0.5 text-xs font-medium text-emerald-800">
                    {formatRange(clipDraft.startTime, clipDraft.endTime)}
                    {clipDraft.confidence && ` · ${clipDraft.confidence} confidence`}
                  </div>
                </div>
                <span className="rounded border border-emerald-200 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                  Unsaved
                </span>
              </div>
              {clipDraft.rationale && (
                <p className="mt-2 text-xs leading-5 text-emerald-900">{clipDraft.rationale}</p>
              )}
              {clipDraft.warnings && clipDraft.warnings.length > 0 && (
                <div className="mt-2 space-y-1">
                  {clipDraft.warnings.map((warning) => (
                    <div key={warning} className="text-xs text-amber-800">
                      {warning}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" className="btn-outline bg-white px-2 py-1.5 text-xs" onClick={() => void onPreviewDraft()}>
                  Preview
                </button>
                <button type="button" className="btn-primary px-2 py-1.5 text-xs" onClick={() => void onSaveDraft()}>
                  Save Clip
                </button>
                <button type="button" className="btn-outline bg-white px-2 py-1.5 text-xs" onClick={() => void onExportDraftPdf()} disabled={exporting}>
                  Export PDF
                </button>
                <button type="button" className="btn-outline bg-white px-2 py-1.5 text-xs" onClick={() => void onExportDraftMedia()} disabled={exporting}>
                  Export Media
                </button>
              </div>
              <button type="button" className="mt-2 text-xs font-medium text-emerald-800 hover:text-emerald-950" onClick={onClearDraft}>
                Clear draft
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-950">Manual Clip Builder</h3>
            <p className="mt-0.5 text-xs text-gray-600">Set exact range, then save or export.</p>
          </div>
          {clipsLoading && <span className="text-xs text-gray-500">Loading...</span>}
        </div>

        {!canEditClips && (
          <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            You can draft, preview, and export here. Open this transcript from Case Detail to save clips.
          </div>
        )}

        <div className="space-y-3">
          <label className="block text-xs font-medium text-gray-700">
            Clip name
            <input
              type="text"
              value={clipName}
              onChange={(event) => setClipName(event.target.value)}
              className="input-field mt-1 h-9 w-full text-sm"
              placeholder="Knife testimony"
              disabled={!hasTranscript}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-gray-700">
              Start
              <input
                type="text"
                value={clipStart}
                onChange={(event) => setClipStart(event.target.value)}
                className="input-field mt-1 h-9 text-sm"
                placeholder="0:00"
                disabled={!hasTranscript}
              />
            </label>
            <label className="block text-xs font-medium text-gray-700">
              End
              <input
                type="text"
                value={clipEnd}
                onChange={(event) => setClipEnd(event.target.value)}
                className="input-field mt-1 h-9 text-sm"
                placeholder="0:00"
                disabled={!hasTranscript}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn-outline px-2 py-1.5 text-xs"
              disabled={!hasTranscript || !selectedLineId}
              onClick={() => {
                const selected = transcript?.lines.find((line) => line.id === selectedLineId)
                if (selected) setClipStart(formatClock(selected.start))
              }}
            >
              Start from selected
            </button>
            <button
              type="button"
              className="btn-outline px-2 py-1.5 text-xs"
              disabled={!hasTranscript || !selectedLineId}
              onClick={() => {
                if (!transcript) return
                const selectedIdx = transcript.lines.findIndex((line) => line.id === selectedLineId)
                if (selectedIdx < 0) return
                const nextLine = transcript.lines[selectedIdx + 1]
                if (nextLine) {
                  setClipEnd(formatClock(Math.max(0, nextLine.start - 0.1)))
                } else {
                  setClipEnd(formatClock(transcript.lines[selectedIdx].end))
                }
              }}
            >
              End from selected
            </button>
          </div>

          <button
            type="button"
            className="btn-primary w-full px-3 py-2 text-sm"
            disabled={!hasTranscript}
            onClick={() => void onCreateClip()}
          >
            Save Clip
          </button>
        </div>
      </div>

      {clipError && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {clipError}
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-950">Saved Clips</h3>
          <span className="text-xs text-gray-500">{clips.length} total</span>
        </div>

        {groupedVisibleClips.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white px-3 py-4 text-xs text-gray-500">
            No clips created yet.
          </div>
        ) : (
          <div className="space-y-3">
            {groupedVisibleClips.map(([sourceKey, sourceClips]) => (
              <div key={sourceKey}>
                {queryCaseId && (
                  <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">
                    {sourceKey === currentMediaKey ? 'Current recording' : sourceKey}
                  </div>
                )}
                <div className="space-y-2">
                  {sourceClips.map((clip, index) => (
                    <div
                      key={clip.clip_id}
                      className={`rounded-lg border bg-white p-3 text-xs shadow-sm transition-colors ${activeClipPlaybackId === clip.clip_id ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}
                      draggable={canEditClips}
                      onDragStart={() => setDragClipId(clip.clip_id)}
                      onDragOver={(event) => {
                        if (!canEditClips) return
                        event.preventDefault()
                      }}
                      onDrop={(event) => {
                        if (!canEditClips) return
                        event.preventDefault()
                        if (dragClipId) {
                          void onReorderVisibleClips(dragClipId, clip.clip_id)
                        }
                        setDragClipId(null)
                      }}
                    >
                      {editingClip?.id === clip.clip_id ? (
                        <div className="space-y-2">
                          <input
                            className="input-field h-8 w-full text-xs"
                            value={editingClip.name}
                            onChange={(event) => setEditingClip({ ...editingClip, name: event.target.value })}
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              className="input-field h-8 text-xs"
                              value={editingClip.start}
                              onChange={(event) => setEditingClip({ ...editingClip, start: event.target.value })}
                            />
                            <input
                              className="input-field h-8 text-xs"
                              value={editingClip.end}
                              onChange={(event) => setEditingClip({ ...editingClip, end: event.target.value })}
                            />
                          </div>
                          <div className="flex gap-2">
                            <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void onSaveEditedClip()}>
                              Save
                            </button>
                            <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={onCancelEditingClip}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-[11px] font-semibold uppercase text-gray-400">Clip {index + 1}</div>
                              <div className="mt-0.5 text-sm font-semibold text-gray-900">{clip.name}</div>
                              <div className="mt-0.5 text-xs text-gray-600">{formatRange(clip.start_time, clip.end_time)}</div>
                            </div>
                            {canEditClips && (
                              <span className="cursor-grab rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-500">
                                Drag
                              </span>
                            )}
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button type="button" className="btn-primary px-2 py-1.5 text-xs" onClick={() => void onPlayClip(clip)}>
                              Preview
                            </button>
                            <button type="button" className="btn-outline px-2 py-1.5 text-xs" onClick={() => onStartEditingClip(clip)}>
                              Edit
                            </button>
                            <button type="button" className="btn-outline px-2 py-1.5 text-xs" onClick={() => void onExportClipPdf(clip)} disabled={exporting}>
                              Export PDF
                            </button>
                            <button type="button" className="btn-outline px-2 py-1.5 text-xs" onClick={() => void onExportClipMedia(clip)} disabled={exporting}>
                              Export Media
                            </button>
                          </div>
                          <button type="button" className="mt-2 text-xs font-medium text-red-700 hover:text-red-900" onClick={() => void onRemoveClip(clip)}>
                            Delete clip
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
