import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'TranscribeAlpha - Legal Transcript Generator',
  description: 'Professional legal transcript generation using Google Gemini AI',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}