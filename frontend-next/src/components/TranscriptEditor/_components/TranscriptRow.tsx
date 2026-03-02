'use client'

import React from 'react'
import { TranscriptRowProps } from '../editorTypes'
import { secondsToLabel } from '../editorUtils'

export const TranscriptRow = React.memo(function TranscriptRow({
  line,
  isActive,
  isSelected,
  isSearchMatch,
  isCurrentSearchMatch,
  editingField,
  onSelect,
  onDoubleClick,
  onBeginEdit,
  onCommitEdit,
  onCancelEdit,
  onEditingFieldChange,
  onLineFieldChange,
  editInputRef,
}: TranscriptRowProps) {
  const rowBackgroundClass = isSelected
    ? 'bg-primary-100 hover:bg-primary-100'
    : isCurrentSearchMatch
      ? 'bg-amber-300'
      : isSearchMatch
        ? 'bg-amber-100'
        : isActive
          ? 'bg-yellow-200'
          : 'bg-white hover:bg-primary-200'
  const rowClasses = [
    'grid grid-cols-[70px_170px_minmax(0,1fr)_140px] items-start gap-3 border-b border-primary-100 px-5 py-3 text-sm transition-colors',
    rowBackgroundClass,
    isSelected ? 'ring-2 ring-inset ring-primary-500 border-l-4 border-l-primary-600' : '',
  ]
  const timingInputClass = line.timestamp_error
    ? 'w-28 rounded border border-red-400 bg-red-50 px-2 py-1.5 text-sm text-red-700 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-400 text-right font-mono tabular-nums'
    : 'w-28 rounded border border-primary-200 px-2 py-1.5 text-sm text-primary-800 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-400 text-right font-mono tabular-nums'

  const isEditingSpeaker = editingField && editingField.lineId === line.id && editingField.field === 'speaker'
  const isEditingText = editingField && editingField.lineId === line.id && editingField.field === 'text'

  return (
    <div
      onClick={() => onSelect(line.id)}
      onDoubleClick={() => onDoubleClick(line)}
      className={rowClasses.join(' ')}
    >
      <div className="text-sm font-mono text-primary-500">
        {line.page ?? '—'}:{line.line ?? '—'}
      </div>
      <div
        className="min-w-0 cursor-pointer truncate text-primary-900 pr-4"
        onClick={(event) => {
          event.stopPropagation()
          if (!isSelected) {
            onSelect(line.id)
            return
          }
          onBeginEdit(line, 'speaker')
        }}
      >
        {isEditingSpeaker ? (
          <input
            ref={editInputRef as React.MutableRefObject<HTMLInputElement | null>}
            className="input text-sm uppercase"
            value={editingField!.value}
            onChange={(event) =>
              onEditingFieldChange((prev) =>
                prev ? { ...prev, value: event.target.value.toUpperCase() } : prev,
              )
            }
            onBlur={onCommitEdit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onCommitEdit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onCancelEdit()
              }
            }}
          />
        ) : (
          <span className="uppercase">{line.speaker || '—'}</span>
        )}
      </div>
      <div
        className="min-w-0 cursor-text whitespace-pre-wrap break-words font-mono text-primary-800"
        onClick={(event) => {
          event.stopPropagation()
          if (!isSelected) {
            onSelect(line.id)
            return
          }
          onBeginEdit(line, 'text')
        }}
      >
        {isEditingText ? (
          <textarea
            ref={editInputRef as React.MutableRefObject<HTMLTextAreaElement | null>}
            className="textarea text-sm"
            rows={3}
            value={editingField!.value}
            onChange={(event) =>
              onEditingFieldChange((prev) => (prev ? { ...prev, value: event.target.value } : prev))
            }
            onBlur={onCommitEdit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onCommitEdit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onCancelEdit()
              }
            }}
          />
        ) : (
          <span>{line.text || '—'}</span>
        )}
      </div>
      <div className="flex flex-col items-end gap-2 text-sm text-primary-600">
        {isSelected ? (
          <>
            <div className="flex items-center gap-2 text-xs text-primary-500">
              <span className="uppercase tracking-wide text-xs text-primary-400">Start</span>
              <input
                type="number"
                step="0.01"
                min={0}
                value={line.start}
                onChange={(event) =>
                  onLineFieldChange(line.id, 'start', parseFloat(event.target.value))
                }
                className={timingInputClass}
                title={line.timestamp_error ? 'Missing timestamp — adjust start/end to fix.' : undefined}
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-primary-500">
              <span className="uppercase tracking-wide text-xs text-primary-400">End</span>
              <input
                type="number"
                step="0.01"
                min={0}
                value={line.end}
                onChange={(event) =>
                  onLineFieldChange(line.id, 'end', parseFloat(event.target.value))
                }
                className={timingInputClass}
                title={line.timestamp_error ? 'Missing timestamp — adjust start/end to fix.' : undefined}
              />
            </div>
            {line.timestamp_error && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-red-600">
                Fix timing
              </span>
            )}
          </>
        ) : (
          <span className="font-mono tabular-nums text-xs text-primary-600">
            {secondsToLabel(line.start)}
          </span>
        )}
      </div>
    </div>
  )
})
