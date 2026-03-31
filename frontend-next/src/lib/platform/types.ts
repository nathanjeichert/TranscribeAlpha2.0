// ─── Platform Adapter Interfaces ─────────────────────────────────────
//
// These interfaces define the contract between storage.ts (business logic)
// and the underlying platform (web File System Access API vs Tauri native FS).
// All paths are workspace-relative and forward-slash separated.

export type WorkspaceInitStatus = 'ok' | 'no-handle' | 'permission-denied' | 'permission-prompt' | 'error'

export interface WorkspaceInitResult {
  status: WorkspaceInitStatus
  /** Opaque handle — web returns FileSystemDirectoryHandle, Tauri returns null */
  handle: unknown
}

export interface PlatformMedia {
  pickMediaFiles(): Promise<Array<{
    file: File; handleId: string; filename: string; fileSizeBytes: number; filePath?: string; fileHandle?: FileSystemFileHandle
  }>>
  promptRelinkMedia(expectedFilename: string, preferredHandleId?: string): Promise<{
    handleId: string
  } | null>
  getPlaybackURL(sourceId: string): Promise<string | null>
  /** Read an absolute file path and return a blob object URL (Tauri only, web returns null). */
  readAbsolutePathAsObjectURL(absolutePath: string, filename: string, fallbackContentType?: string): Promise<string | null>
  /** Read a file from an absolute path and return as File (Tauri only, web returns null). */
  readFileFromPath(absolutePath: string, filename: string): Promise<File | null>
  downloadFile(blob: Blob, filename: string): Promise<void>
}

export interface PlatformFS {
  // ─── Workspace lifecycle ──────────────────────────────────────────
  pickWorkspaceDirectory(): Promise<{ isExisting: boolean }>
  initWorkspace(): Promise<WorkspaceInitResult>
  isWorkspaceConfigured(): Promise<boolean>
  clearWorkspace(): Promise<void>
  getWorkspaceName(): string | null
  getStorageEstimate(): Promise<{ fileCount: number; totalSize: number }>

  // ─── Low-level file I/O (all paths workspace-relative) ───────────
  readJSON<T>(path: string): Promise<T | null>
  writeJSON(path: string, data: unknown): Promise<void>
  readBinaryFile(path: string): Promise<ArrayBuffer | null>
  writeBinaryFile(path: string, data: ArrayBuffer | Uint8Array | Blob): Promise<void>
  deleteFile(path: string): Promise<void>
  deleteDirectory(path: string): Promise<void>
  listDirectory(path: string): Promise<string[]>
  fileExists(path: string): Promise<boolean>
  readFileAsFile(path: string): Promise<File | null>

  // ─── Platform-specific ───────────────────────────────────────────
  /** Native absolute workspace path (Tauri only — web returns null). */
  getWorkspaceBasePath(): string | null
  getWorkspaceHandle(): FileSystemDirectoryHandle | null
  resolveWorkspaceRelativePathForHandle(fileHandle: FileSystemFileHandle): Promise<string | null>
}
