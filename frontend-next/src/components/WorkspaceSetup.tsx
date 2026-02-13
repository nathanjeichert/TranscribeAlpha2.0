'use client'

import { useState } from 'react'
import { pickAndInitWorkspace } from '@/lib/storage'

interface WorkspaceSetupProps {
  onComplete: () => void
}

export default function WorkspaceSetup({ onComplete }: WorkspaceSetupProps) {
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const [isReturning, setIsReturning] = useState(false)

  const handleChooseFolder = async () => {
    setPicking(true)
    setError('')
    try {
      const { isExisting } = await pickAndInitWorkspace()

      if (isExisting) {
        setIsReturning(true)
        // Small delay so user sees the "Welcome back" message
        setTimeout(() => onComplete(), 800)
      } else {
        onComplete()
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // User cancelled the picker
        setPicking(false)
        return
      }
      setError(err?.message || 'Failed to set up workspace folder')
      setPicking(false)
    }
  }

  if (isReturning) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900">
        <div className="max-w-md text-center px-6">
          <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Welcome back!</h1>
          <p className="text-slate-300">We found your existing data. Loading your workspace...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900">
      <div className="max-w-lg text-center px-6">
        <div className="w-20 h-20 bg-primary-500/20 rounded-2xl flex items-center justify-center mx-auto mb-8">
          <svg className="w-10 h-10 text-primary-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
        </div>

        <h1 className="text-3xl font-bold text-white mb-3">Welcome to TranscribeAlpha</h1>
        <p className="text-slate-300 text-lg mb-8 leading-relaxed">
          Choose a folder to store your case data. Files in that folder stay linked
          automatically. Files outside it can still be used and may need a quick reconnect.
        </p>

        {error && (
          <div className="mb-6 bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-300 text-sm">
            {error}
          </div>
        )}

        <button
          onClick={handleChooseFolder}
          disabled={picking}
          className="px-8 py-4 bg-primary-600 hover:bg-primary-500 text-white rounded-xl font-semibold text-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {picking ? (
            <span className="flex items-center gap-3">
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Setting up...
            </span>
          ) : (
            'Choose Folder'
          )}
        </button>

        <p className="text-slate-500 text-sm mt-6">
          Works best in Chrome or Edge. Your data stays on your computer.
        </p>
      </div>
    </div>
  )
}
