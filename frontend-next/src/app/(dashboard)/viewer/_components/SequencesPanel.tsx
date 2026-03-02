import { formatClock, formatRange } from '@/utils/transcriptFormat'
import type { ClipRecord, ClipSequenceRecord } from '@/lib/storage'
import type { SequencePauseBehavior, SequenceState } from '../viewerTypes'

interface SequencesPanelProps {
  clips: ClipRecord[]
  sequences: ClipSequenceRecord[]
  canEditClips: boolean
  exporting: boolean
  sequencePauseBehavior: SequencePauseBehavior
  setSequencePauseBehavior: (v: SequencePauseBehavior) => void
  clipGapSeconds: number
  setClipGapSeconds: (v: number) => void
  sequenceState: SequenceState
  newSequenceName: string
  setNewSequenceName: (v: string) => void
  selectedSequenceId: string | null
  setSelectedSequenceId: (id: string | null) => void
  sequenceNameDrafts: Record<string, string>
  setSequenceNameDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void
  sequenceError: string
  sequenceExportStatus: string
  onCreateSequence: () => void
  onRemoveSequence: (sequence: ClipSequenceRecord) => void
  onCommitSequenceRename: (sequence: ClipSequenceRecord) => void
  onAddClipToSequence: (sequence: ClipSequenceRecord, clipId: string) => void
  onRemoveSequenceEntry: (sequence: ClipSequenceRecord, index: number) => void
  onMoveSequenceEntry: (sequence: ClipSequenceRecord, from: number, to: number) => void
  onRunSequencePresentation: (sequence: ClipSequenceRecord) => void
  onExportSequenceZip: (sequence: ClipSequenceRecord) => void
}

export function SequencesPanel({
  clips,
  sequences,
  canEditClips,
  exporting,
  sequencePauseBehavior,
  setSequencePauseBehavior,
  clipGapSeconds,
  setClipGapSeconds,
  sequenceState,
  newSequenceName,
  setNewSequenceName,
  selectedSequenceId,
  setSelectedSequenceId,
  sequenceNameDrafts,
  setSequenceNameDrafts,
  sequenceError,
  sequenceExportStatus,
  onCreateSequence,
  onRemoveSequence,
  onCommitSequenceRename,
  onAddClipToSequence,
  onRemoveSequenceEntry,
  onMoveSequenceEntry,
  onRunSequencePresentation,
  onExportSequenceZip,
}: SequencesPanelProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 p-3">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Sequences</h3>
        </div>

        <label className="mb-3 block text-xs text-gray-700">
          <span className="mb-1 block font-medium">Between clips</span>
          <select
            className="w-full rounded-lg border border-primary-300 bg-white px-2 py-1.5 text-xs shadow-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
            value={sequencePauseBehavior}
            onChange={(e) => setSequencePauseBehavior(e.target.value as SequencePauseBehavior)}
          >
            <option value="black-screen">Pause on black screen</option>
            <option value="title-card">Pause on title card</option>
            <option value="continuous">Play continuously</option>
          </select>
        </label>

        {sequencePauseBehavior === 'continuous' && (
          <label className="mb-3 block text-xs text-gray-700">
            <span className="mb-1 block font-medium">Gap between clips (seconds)</span>
            <input
              type="number"
              min="0"
              max="30"
              step="0.5"
              className="w-full rounded-lg border border-primary-300 bg-white px-2 py-1.5 text-xs shadow-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
              value={clipGapSeconds}
              onChange={(e) => {
                const val = Number(e.target.value)
                if (Number.isFinite(val) && val >= 0) setClipGapSeconds(val)
              }}
            />
          </label>
        )}

        {sequenceState.phase !== 'idle' && (
          <div className="mb-2 text-xs text-primary-700">
            Playback: {sequenceState.phase}
          </div>
        )}

        <div className="space-y-2">
          <input
            className="input-field h-9 w-full text-sm"
            value={newSequenceName}
            onChange={(e) => setNewSequenceName(e.target.value)}
            placeholder="New sequence name"
            disabled={!canEditClips}
          />
          <button
            type="button"
            className="btn-primary w-full px-3 py-1.5 text-sm"
            disabled={!canEditClips}
            onClick={() => void onCreateSequence()}
          >
            Create Sequence
          </button>
        </div>
      </div>

      {sequenceError && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {sequenceError}
        </div>
      )}
      {sequenceExportStatus && (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          {sequenceExportStatus}
        </div>
      )}

      <div className="space-y-2">
        {sequences.length === 0 ? (
          <div className="rounded border border-dashed border-gray-200 p-3 text-xs text-gray-500">
            No sequences yet.
          </div>
        ) : (
          sequences.map((sequence) => {
            const ordered = [...sequence.entries].sort((a, b) => a.order - b.order)
            const totalDuration = ordered.reduce((total, entry) => {
              const clip = clips.find((item) => item.clip_id === entry.clip_id)
              if (!clip) return total
              return total + Math.max(0, clip.end_time - clip.start_time)
            }, 0)

            return (
              <div key={sequence.sequence_id} className="rounded-lg border border-gray-200 bg-gray-50 p-2">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedSequenceId(selectedSequenceId === sequence.sequence_id ? null : sequence.sequence_id)}
                    className="flex-1 text-left"
                  >
                    <div className="text-xs font-semibold text-gray-900">{sequence.name}</div>
                    <div className="text-[11px] text-gray-600">
                      {ordered.length} clips • {formatClock(totalDuration)}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="btn-outline px-2 py-1 text-xs"
                    onClick={() => void onRunSequencePresentation(sequence)}
                  >
                    Present
                  </button>
                  <button
                    type="button"
                    className="btn-outline px-2 py-1 text-xs"
                    onClick={() => void onExportSequenceZip(sequence)}
                    disabled={exporting}
                  >
                    ZIP
                  </button>
                  <button
                    type="button"
                    className="btn-outline px-2 py-1 text-xs text-red-700"
                    onClick={() => void onRemoveSequence(sequence)}
                  >
                    Delete
                  </button>
                </div>

                {selectedSequenceId === sequence.sequence_id && (
                  <div className="mt-2 space-y-2 border-t border-gray-200 pt-2">
                    <input
                      className="input-field h-8 w-full text-xs"
                      value={sequenceNameDrafts[sequence.sequence_id] ?? sequence.name}
                      onChange={(event) => {
                        const nextName = event.target.value
                        setSequenceNameDrafts((prev) => ({ ...prev, [sequence.sequence_id]: nextName }))
                      }}
                      onBlur={() => {
                        void onCommitSequenceRename(sequence)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          event.currentTarget.blur()
                        }
                      }}
                    />

                    <select
                      className="w-full rounded-lg border border-primary-300 bg-white px-2 py-1.5 text-xs shadow-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
                      onChange={(event) => {
                        const value = event.target.value
                        if (value) {
                          void onAddClipToSequence(sequence, value)
                          event.target.value = ''
                        }
                      }}
                    >
                      <option value="">Add clip...</option>
                      {clips.map((clip) => (
                        <option key={clip.clip_id} value={clip.clip_id}>
                          {clip.name} ({formatRange(clip.start_time, clip.end_time)})
                        </option>
                      ))}
                    </select>

                    <div className="space-y-1">
                      {ordered.map((entry, index) => {
                        const clip = clips.find((item) => item.clip_id === entry.clip_id)
                        if (!clip) return null

                        return (
                          <div key={`${entry.clip_id}-${index}`} className="flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-gray-800">{clip.name}</div>
                              <div className="text-[11px] text-gray-600">{formatRange(clip.start_time, clip.end_time)}</div>
                            </div>
                            <button
                              type="button"
                              className="btn-outline px-1.5 py-0.5 text-[11px]"
                              onClick={() => void onMoveSequenceEntry(sequence, index, index - 1)}
                              disabled={index === 0}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn-outline px-1.5 py-0.5 text-[11px]"
                              onClick={() => void onMoveSequenceEntry(sequence, index, index + 1)}
                              disabled={index === ordered.length - 1}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="btn-outline px-1.5 py-0.5 text-[11px] text-red-700"
                              onClick={() => void onRemoveSequenceEntry(sequence, index)}
                            >
                              x
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
