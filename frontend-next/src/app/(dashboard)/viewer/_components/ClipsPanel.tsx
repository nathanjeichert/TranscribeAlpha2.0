import { formatClock, formatRange, type ViewerTranscript } from '@/utils/transcriptFormat'
import type { ClipRecord } from '@/lib/storage'

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
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 p-3">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Clip Builder</h3>
          {clipsLoading && <span className="text-xs text-gray-500">Loading...</span>}
        </div>

        {!canEditClips && (
          <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Clips require case context. Open this transcript from Case Detail to edit clips.
          </div>
        )}

        <div className="space-y-2">
          <input
            type="text"
            value={clipName}
            onChange={(e) => setClipName(e.target.value)}
            className="input-field h-9 w-full text-sm"
            placeholder="Clip name"
            disabled={!canEditClips}
          />

          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={clipStart}
              onChange={(e) => setClipStart(e.target.value)}
              className="input-field h-9 text-sm"
              placeholder="Start (0:00)"
              disabled={!canEditClips}
            />
            <input
              type="text"
              value={clipEnd}
              onChange={(e) => setClipEnd(e.target.value)}
              className="input-field h-9 text-sm"
              placeholder="End (0:00)"
              disabled={!canEditClips}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-outline px-2 py-1 text-xs"
              disabled={!canEditClips || !selectedLineId}
              onClick={() => {
                const selected = transcript?.lines.find((line) => line.id === selectedLineId)
                if (selected) setClipStart(formatClock(selected.start))
              }}
            >
              Start from line
            </button>
            <button
              type="button"
              className="btn-outline px-2 py-1 text-xs"
              disabled={!canEditClips || !selectedLineId}
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
              End from line
            </button>
          </div>

          <button
            type="button"
            className="btn-primary w-full px-3 py-2 text-sm"
            disabled={!canEditClips}
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

      <div className="space-y-3">
        {groupedVisibleClips.length === 0 ? (
          <div className="rounded border border-dashed border-gray-200 p-3 text-xs text-gray-500">
            No clips created yet.
          </div>
        ) : (
          groupedVisibleClips.map(([sourceKey, sourceClips]) => (
            <div key={sourceKey}>
              {queryCaseId && (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  {sourceKey === currentMediaKey ? 'Current recording' : sourceKey}
                </div>
              )}
              <div className="space-y-2">
                {sourceClips.map((clip) => (
                  <div
                    key={clip.clip_id}
                    className={`rounded-lg border p-2 text-xs ${activeClipPlaybackId === clip.clip_id ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}
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
                          onChange={(e) => setEditingClip({ ...editingClip, name: e.target.value })}
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            className="input-field h-8 text-xs"
                            value={editingClip.start}
                            onChange={(e) => setEditingClip({ ...editingClip, start: e.target.value })}
                          />
                          <input
                            className="input-field h-8 text-xs"
                            value={editingClip.end}
                            onChange={(e) => setEditingClip({ ...editingClip, end: e.target.value })}
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
                        <div className="font-medium text-gray-800">{clip.name}</div>
                        <div className="mt-0.5 text-gray-600">{formatRange(clip.start_time, clip.end_time)}</div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => void onPlayClip(clip)}>
                            Play
                          </button>
                          <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => onStartEditingClip(clip)}>
                            Edit
                          </button>
                          <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => void onExportClipPdf(clip)} disabled={exporting}>
                            Export PDF
                          </button>
                          <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => void onExportClipMedia(clip)} disabled={exporting}>
                            Export Media
                          </button>
                          <button type="button" className="btn-outline px-2 py-1 text-xs text-red-700" onClick={() => void onRemoveClip(clip)}>
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
