interface CaptionWindowProps {
  captionWindow: {
    prev2: string
    prev1: string
    current: string
    next1: string
    next2: string
  }
}

export function CaptionWindow({ captionWindow }: CaptionWindowProps) {
  return (
    <div className="shrink-0 max-h-[24vh] overflow-y-auto rounded-xl border border-stone-300 bg-[#fffef8] px-6 py-4 shadow-sm">
      <div className="space-y-2 font-mono">
        <div className="text-base text-stone-400">{captionWindow.prev2}</div>
        <div className="text-lg text-stone-500">{captionWindow.prev1}</div>
        <div className="rounded border border-blue-200 bg-blue-50/45 px-3 py-2 text-2xl leading-snug text-stone-900">
          {captionWindow.current}
        </div>
        <div className="text-lg text-stone-500">{captionWindow.next1}</div>
        <div className="text-base text-stone-400">{captionWindow.next2}</div>
      </div>
    </div>
  )
}
