import { useCallback, useMemo, useRef, useState } from 'react'
import { EditorLine, EditingField } from '../editorTypes'
import { AUTO_SHIFT_PADDING_SECONDS } from '../editorUtils'

export function useEditorLines(initialLines: EditorLine[]) {
  const [lines, setLines] = useState<EditorLine[]>(initialLines)
  const [isDirty, setIsDirty] = useState(false)
  const [editingField, setEditingField] = useState<EditingField | null>(null)
  const [autoShiftNextLine, setAutoShiftNextLine] = useState(true)
  const [history, setHistory] = useState<EditorLine[][]>([])
  const [future, setFuture] = useState<EditorLine[][]>([])
  const [addError, setAddError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [renameFeedback, setRenameFeedback] = useState<string | null>(null)

  // Skip resetting isDirty/history in sync effect when we've just done a local update (e.g., resync)
  const skipSyncEffectResetRef = useRef(false)

  const cloneLines = useCallback((source: EditorLine[]) => source.map((line) => ({ ...line })), [])

  const pushHistory = useCallback(
    (snapshot: EditorLine[]) => {
      setHistory((prev) => [...prev.slice(-49), cloneLines(snapshot)])
      setFuture([])
    },
    [cloneLines],
  )

  const resetHistory = useCallback(() => {
    setHistory([])
    setFuture([])
  }, [])

  const hasPendingInlineEdit = useMemo(() => {
    if (!editingField) return false
    const line = lines.find((entry) => entry.id === editingField.lineId)
    if (!line) return false
    const currentValue = editingField.field === 'speaker' ? line.speaker : line.text
    return currentValue !== editingField.value
  }, [editingField, lines])

  const materializeLinesForSave = useCallback((): EditorLine[] => {
    if (!editingField || !hasPendingInlineEdit) return lines
    return lines.map((line) =>
      line.id === editingField.lineId
        ? {
          ...line,
          [editingField.field]: editingField.value,
          ...(editingField.field === 'speaker' || editingField.field === 'text' ? { rendered_text: undefined } : null),
        }
        : line,
    )
  }, [editingField, hasPendingInlineEdit, lines])

  const handleLineFieldChange = useCallback(
    (lineId: string, field: keyof EditorLine, value: string | number) => {
      setLines((prev) => {
        const normalizedValue =
          field === 'speaker' || field === 'text'
            ? typeof value === 'string'
              ? value
              : value.toString()
            : typeof value === 'number'
              ? value
              : parseFloat(value as string) || 0

        const nextLines = prev.map((line) =>
          line.id === lineId
            ? {
              ...line,
              [field]: normalizedValue,
              ...(field === 'speaker' || field === 'text' ? { rendered_text: undefined } : null),
              ...(field === 'start' || field === 'end' ? { timestamp_error: false } : null),
            }
            : line,
        )

        if (field === 'end' && autoShiftNextLine) {
          const targetIndex = nextLines.findIndex((line) => line.id === lineId)
          if (targetIndex >= 0 && nextLines[targetIndex + 1]) {
            const targetLine = nextLines[targetIndex]
            const followingLine = nextLines[targetIndex + 1]
            const numericEnd =
              typeof normalizedValue === 'number'
                ? normalizedValue
                : parseFloat(normalizedValue as string) || targetLine.end
            const adjustedStart = Math.max(0, parseFloat((numericEnd + AUTO_SHIFT_PADDING_SECONDS).toFixed(3)))
            nextLines[targetIndex + 1] = { ...followingLine, start: adjustedStart }
          }
        }

        return nextLines
      })
      setIsDirty(true)
    },
    [autoShiftNextLine],
  )

  const beginEdit = useCallback((line: EditorLine, field: 'speaker' | 'text') => {
    setEditingField({
      lineId: line.id,
      field,
      value: field === 'speaker' ? line.speaker : line.text,
    })
  }, [])

  const commitEdit = useCallback(() => {
    if (!editingField) return
    pushHistory(lines)
    handleLineFieldChange(editingField.lineId, editingField.field, editingField.value)
    setEditingField(null)
  }, [editingField, handleLineFieldChange, lines, pushHistory])

  const cancelEdit = useCallback(() => {
    setEditingField(null)
  }, [])

  // Returns the new line's ID so the component can update selectedLineId in the player hook
  const handleAddUtterance = useCallback(
    (selectedLineId: string | null, activeLineId: string | null, audioDuration?: number): string | null => {
      setAddError(null)
      setDeleteError(null)
      if (!lines.length) {
        setAddError('No lines available to insert after.')
        return null
      }

      pushHistory(lines)

      const minDuration = 0.2
      const targetId = selectedLineId ?? activeLineId ?? lines[lines.length - 1]?.id
      const targetIndex = lines.findIndex((line) => line.id === targetId)
      if (targetIndex < 0) {
        setAddError('Select a line to insert after.')
        return null
      }

      const currentLine = lines[targetIndex]
      const nextLine = lines[targetIndex + 1]
      const nextStart = nextLine ? Number(nextLine.start) : null
      const currentStart = Number(currentLine.start) || 0
      const currentEnd = Number(currentLine.end) || currentStart

      let newStart = currentEnd
      let newEnd: number
      let updatedCurrentEnd = currentEnd

      if (nextLine && nextStart !== null && !Number.isNaN(nextStart)) {
        const gap = nextStart - currentEnd
        if (gap >= 2) {
          newStart = currentEnd
          newEnd = nextStart
          if (newEnd - newStart < minDuration) {
            newEnd = newStart + minDuration
          }
        } else {
          const duration = Math.max(currentEnd - currentStart, minDuration * 2)
          updatedCurrentEnd = currentStart + duration / 2
          newStart = updatedCurrentEnd
          newEnd = Math.min(currentStart + duration, nextStart)
          if (newEnd - newStart < minDuration) {
            newEnd = newStart + minDuration
          }
        }
      } else {
        const fallbackDuration = Math.max((audioDuration ?? 0) - currentEnd, minDuration)
        newStart = currentEnd
        newEnd = newStart + fallbackDuration
      }

      const newLineId = `new-${Date.now()}`
      const updatedLines = [...lines]
      updatedLines[targetIndex] = { ...currentLine, end: updatedCurrentEnd }
      updatedLines.splice(targetIndex + 1, 0, {
        id: newLineId,
        speaker: currentLine.speaker,
        text: '',
        start: newStart,
        end: newEnd,
        is_continuation: false,
      })

      setLines(updatedLines)
      setEditingField({ lineId: newLineId, field: 'text', value: '' })
      setIsDirty(true)
      return newLineId
    },
    [lines, pushHistory],
  )

  // Returns the next selection ID so the component can update selectedLineId in the player hook
  const handleDeleteUtterance = useCallback(
    (selectedLineId: string | null, activeLineId: string | null): string | null => {
      setDeleteError(null)
      setAddError(null)
      if (!lines.length) {
        setDeleteError('No lines to delete.')
        return null
      }
      const targetId = selectedLineId ?? activeLineId
      if (!targetId) {
        setDeleteError('Select a line to delete.')
        return null
      }
      const targetIndex = lines.findIndex((line) => line.id === targetId)
      if (targetIndex < 0) {
        setDeleteError('Select a line to delete.')
        return null
      }
      if (lines.length === 1) {
        setDeleteError('At least one utterance must remain.')
        return null
      }

      pushHistory(lines)

      const nextSelection = lines[targetIndex + 1]?.id || lines[targetIndex - 1]?.id || null
      setLines(lines.filter((line) => line.id !== targetId))
      setIsDirty(true)
      return nextSelection
    },
    [lines, pushHistory],
  )

  const handleRenameSpeaker = useCallback(
    (event?: React.FormEvent) => {
      if (event) event.preventDefault()
      const source = renameFrom.trim()
      const target = renameTo.trim()
      if (!source || !target) {
        setRenameFeedback('Enter both the current and new speaker names.')
        return
      }
      pushHistory(lines)
      const normalizedSource = source.toUpperCase()
      const normalizedTarget = target.toUpperCase()
      let changes = 0
      setLines((prev) =>
        prev.map((line) => {
          if (line.speaker.trim().toUpperCase() === normalizedSource) {
            changes += 1
            return { ...line, speaker: normalizedTarget, rendered_text: undefined }
          }
          return line
        }),
      )
      if (changes === 0) {
        setRenameFeedback('No matching speaker labels were found.')
        return
      }
      setIsDirty(true)
      setRenameFeedback(`Renamed ${changes} line${changes === 1 ? '' : 's'}. Save to update exports.`)
    },
    [renameFrom, renameTo, lines, pushHistory],
  )

  const handleUndo = useCallback(() => {
    if (!history.length) return
    const previous = history[history.length - 1]
    setHistory((prev) => prev.slice(0, prev.length - 1))
    setFuture((prev) => [cloneLines(lines), ...prev])
    setLines(previous)
    setIsDirty(true)
  }, [history, cloneLines, lines])

  const handleRedo = useCallback(() => {
    if (!future.length) return
    const [next, ...rest] = future
    setFuture(rest)
    setHistory((prev) => [...prev.slice(-49), cloneLines(lines)])
    setLines(next)
    setIsDirty(true)
  }, [future, cloneLines, lines])

  return {
    lines,
    setLines,
    isDirty,
    setIsDirty,
    editingField,
    setEditingField,
    autoShiftNextLine,
    setAutoShiftNextLine,
    history,
    future,
    addError,
    deleteError,
    showRenameModal,
    setShowRenameModal,
    renameFrom,
    setRenameFrom,
    renameTo,
    setRenameTo,
    renameFeedback,
    setRenameFeedback,
    skipSyncEffectResetRef,
    hasPendingInlineEdit,
    materializeLinesForSave,
    cloneLines,
    pushHistory,
    resetHistory,
    handleLineFieldChange,
    beginEdit,
    commitEdit,
    cancelEdit,
    handleAddUtterance,
    handleDeleteUtterance,
    handleRenameSpeaker,
    handleUndo,
    handleRedo,
  }
}
