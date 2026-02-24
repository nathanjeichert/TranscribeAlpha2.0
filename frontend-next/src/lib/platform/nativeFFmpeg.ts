// ─── Native FFmpeg Sidecar Wrapper (Tauri only) ─────────────────────
//
// Invokes a bundled FFmpeg binary via Tauri's shell sidecar API.
// Input/output files live on disk in a temp directory — no WASM, no 2GB limit.

type ProgressCallback = (ratio: number) => void

let cancelled = false

export function cancelNativeFFmpeg(): void {
  cancelled = true
}

// ─── Shell helpers ────────────────────────────────────────────────────

async function getTempDir(): Promise<string> {
  const { tempDir } = await import('@tauri-apps/api/path')
  const base = await tempDir()
  const { mkdir, exists } = await import('@tauri-apps/plugin-fs')
  const dir = `${base}transcribealpha-ffmpeg`
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true })
  }
  return dir
}

async function tempPath(filename: string): Promise<string> {
  const dir = await getTempDir()
  const { sep } = await import('@tauri-apps/api/path')
  const s = typeof sep === 'function' ? (sep as () => string)() : sep
  return `${dir}${s}${filename}`
}

async function writeInputFile(file: File, destPath: string): Promise<void> {
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const bytes = new Uint8Array(await file.arrayBuffer())
  await writeFile(destPath, bytes)
}

async function readOutputFile(path: string, filename: string, mimeType: string): Promise<File> {
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const bytes = await readFile(path)
  return new File([bytes], filename, { type: mimeType })
}

async function cleanup(...paths: string[]): Promise<void> {
  const { remove } = await import('@tauri-apps/plugin-fs')
  for (const p of paths) {
    try {
      await remove(p)
    } catch {
      // Best effort cleanup
    }
  }
}

function parseProgressFromStderr(
  line: string,
  durationSec: number | null,
  onProgress?: ProgressCallback,
): void {
  if (!onProgress || !durationSec) return
  // FFmpeg outputs lines like: time=00:01:23.45
  const match = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return
  const timeSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3])
  const ratio = Math.min(1, Math.max(0, timeSec / durationSec))
  onProgress(ratio)
}

async function runFFmpegSidecar(
  args: string[],
  onProgress?: ProgressCallback,
  durationSec?: number | null,
): Promise<void> {
  const { Command } = await import('@tauri-apps/plugin-shell')
  cancelled = false

  const cmd = Command.sidecar('binaries/ffmpeg', ['-y', '-hide_banner', ...args])
  const child = await cmd.spawn()

  return new Promise<void>((resolve, reject) => {
    let stderr = ''

    cmd.on('close', (data) => {
      if (cancelled) {
        reject(new Error('FFmpeg operation cancelled'))
        return
      }
      if (data.code === 0) {
        resolve()
      } else {
        reject(new Error(`FFmpeg exited with code ${data.code}: ${stderr.slice(-500)}`))
      }
    })

    cmd.on('error', (error) => {
      reject(new Error(`FFmpeg error: ${error}`))
    })

    cmd.stdout.on('data', () => {
      // FFmpeg writes progress to stderr, stdout is rarely used
    })

    cmd.stderr.on('data', (line: string) => {
      stderr += line + '\n'
      parseProgressFromStderr(line, durationSec ?? null, onProgress)
    })

    // Handle cancellation
    if (cancelled) {
      child.kill().catch(() => {})
      reject(new Error('FFmpeg operation cancelled'))
    }
  })
}

// ─── Public API ────────────────────────────────────────────────────────

export async function nativeConvertToPlayable(
  file: File,
  onProgress?: ProgressCallback,
): Promise<File> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'bin'
  const uid = crypto.randomUUID().slice(0, 8)
  const inputPath = await tempPath(`input_${uid}.${ext}`)
  const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm'].includes(ext)
  const outputExt = isVideo ? 'mp4' : 'wav'
  const outputPath = await tempPath(`output_${uid}.${outputExt}`)

  await writeInputFile(file, inputPath)

  try {
    const args = isVideo
      ? ['-i', inputPath, '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', outputPath]
      : ['-i', inputPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath]

    await runFFmpegSidecar(args, onProgress)

    const outputFilename = file.name.replace(/\.[^.]+$/, `_converted.${outputExt}`)
    const mimeType = isVideo ? 'video/mp4' : 'audio/wav'
    return await readOutputFile(outputPath, outputFilename, mimeType)
  } finally {
    await cleanup(inputPath, outputPath)
  }
}

export async function nativeExtractAudio(
  file: File,
  onProgress?: ProgressCallback,
): Promise<File> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'bin'
  const uid = crypto.randomUUID().slice(0, 8)
  const inputPath = await tempPath(`input_${uid}.${ext}`)
  const outputPath = await tempPath(`output_${uid}.mp3`)

  await writeInputFile(file, inputPath)

  try {
    await runFFmpegSidecar(
      ['-i', inputPath, '-map', '0:a:0?', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '96k', outputPath],
      onProgress,
    )

    const outputFilename = file.name.replace(/\.[^.]+$/, '_audio.mp3')
    return await readOutputFile(outputPath, outputFilename, 'audio/mpeg')
  } finally {
    await cleanup(inputPath, outputPath)
  }
}

export async function nativeExtractAudioStereo(
  file: File,
  onProgress?: ProgressCallback,
): Promise<File> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'bin'
  const uid = crypto.randomUUID().slice(0, 8)
  const inputPath = await tempPath(`input_${uid}.${ext}`)
  const outputPath = await tempPath(`output_${uid}.mp3`)

  await writeInputFile(file, inputPath)

  try {
    await runFFmpegSidecar(
      ['-i', inputPath, '-map', '0:a:0?', '-vn', '-sn', '-dn', '-ac', '2', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '128k', outputPath],
      onProgress,
    )

    const outputFilename = file.name.replace(/\.[^.]+$/, '_stereo.mp3')
    return await readOutputFile(outputPath, outputFilename, 'audio/mpeg')
  } finally {
    await cleanup(inputPath, outputPath)
  }
}

export async function nativeClipMedia(
  file: File,
  startTime: number,
  endTime: number,
  downloadStem?: string,
  onProgress?: ProgressCallback,
): Promise<File> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'bin'
  const uid = crypto.randomUUID().slice(0, 8)
  const inputPath = await tempPath(`input_${uid}.${ext}`)
  const outputPath = await tempPath(`output_${uid}.${ext}`)

  await writeInputFile(file, inputPath)

  try {
    const duration = endTime - startTime
    await runFFmpegSidecar(
      [
        '-ss', String(startTime),
        '-i', inputPath,
        '-t', String(duration),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        outputPath,
      ],
      onProgress,
      duration,
    )

    const stem = downloadStem || file.name.replace(/\.[^.]+$/, '_clip')
    const outputFilename = `${stem}.${ext}`
    const mimeMap: Record<string, string> = {
      mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
      wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac',
      ogg: 'audio/ogg', webm: 'video/webm',
    }
    const mimeType = mimeMap[ext] || file.type || 'application/octet-stream'

    return await readOutputFile(outputPath, outputFilename, mimeType)
  } finally {
    await cleanup(inputPath, outputPath)
  }
}
