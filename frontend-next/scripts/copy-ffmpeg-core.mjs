import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const srcDir = path.join(ROOT, 'node_modules', '@ffmpeg', 'core', 'dist', 'umd')
const publicDir = path.join(ROOT, 'public')

const requiredAssets = [
  'ffmpeg-core.js',
  'ffmpeg-core.wasm',
]

const optionalAssets = [
  'ffmpeg-core.worker.js',
]

async function ensureSourceDir() {
  try {
    await stat(srcDir)
  } catch {
    throw new Error(`Missing source directory: ${srcDir}`)
  }
}

async function copyRequiredAsset(name) {
  const srcPath = path.join(srcDir, name)
  const destPath = path.join(publicDir, name)
  await copyFile(srcPath, destPath)
}

async function copyOptionalAsset(name) {
  const srcPath = path.join(srcDir, name)
  const destPath = path.join(publicDir, name)
  try {
    await copyFile(srcPath, destPath)
  } catch (error) {
    if ((error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      return
    }
    throw error
  }
}

async function main() {
  await ensureSourceDir()
  await mkdir(publicDir, { recursive: true })
  await Promise.all(requiredAssets.map(copyRequiredAsset))
  await Promise.all(optionalAssets.map(copyOptionalAsset))
  console.log('Copied ffmpeg core assets into public/')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
