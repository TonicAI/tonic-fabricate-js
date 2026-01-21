import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, copyFileSync } from 'fs'
import got from 'got'
import AdmZip from 'adm-zip'
import { dirname } from 'path'

export interface GenerateProgressInfo {
  percentComplete: number
  status?: string
  phase?: string
}

export interface ConnectionConfig {
  host: string
  port: number
  database_name: string
  username: string
  password: string
  tls?: boolean
}

export interface GenerateOptions {
  apiKey?: string
  apiUrl?: string
  database: string
  workspace: string
  entity?: string | null
  format?: string
  overrides?: Record<string, unknown>
  onProgress?: (info: GenerateProgressInfo) => void
  dest?: string
  unzip?: boolean
  overwrite?: boolean
  connection?: ConnectionConfig | string | null
}

interface GenerateTask {
  id: string
  error?: string
  completed?: boolean
  data_url?: string
  content_type?: string
  progress?: number
  context?: string
  phase?: string
}

/**
 * Generates data for a given database.
 */
export default async function generate({
  apiKey = process.env.FABRICATE_API_KEY,
  apiUrl = process.env.FABRICATE_API_URL || 'https://fabricate.tonic.ai/api/v1',
  database,
  workspace,
  entity = null,
  format,
  overrides,
  onProgress,
  dest,
  unzip = true,
  overwrite = false,
  connection = null,
}: GenerateOptions): Promise<void> {
  if (!apiKey) {
    throw new Error('apiKey is required')
  }

  if (!database) {
    throw new Error('database is required')
  }

  if (!workspace) {
    throw new Error('workspace is required')
  }

  if (!format && !connection) {
    throw new Error('format or connection is required')
  }

  if (format && connection) {
    throw new Error('format and connection cannot both be provided')
  }

  if (!dest && !connection) {
    throw new Error('dest is required unless connection is provided')
  }

  if (dest && existsSync(dest) && !overwrite) {
    throw new Error('dest already exists')
  }

  let res

  try {
    res = await got.post(`${apiUrl}/generate_tasks`, {
      responseType: 'json',
      headers: { Authorization: `Bearer ${apiKey}` },
      json: { format, connection, database, entity, overrides, workspace },
    })
  } catch (e: unknown) {
    const error = e as { response?: { headers?: Record<string, string>; body?: { error?: string } } }
    if (error.response?.headers?.['content-type'] === 'application/json') {
      throw new Error(error.response.body?.error)
    } else {
      throw e
    }
  }

  let task = res.body as GenerateTask

  if (task.error) {
    throw new Error(task.error)
  }

  task = await poll(task.id, apiUrl, apiKey, onProgress)

  const { data_url, error } = task

  if (error) {
    console.error('Fabricate API returned an error: ' + error)
    process.exit(1)
  }

  if (connection == null && dest) {
    // Create temp file paths
    const tempPath = `${dest}.tmp`

    try {
      // Download to temp location first
      await download(data_url!, tempPath)

      if (unzip && task.content_type === 'application/zip') {
        await unzipFile(tempPath, dest)
      } else {
        // Use cross-device safe move that falls back to copy-and-delete if rename fails.
        try {
          renameSync(tempPath, dest)
        } catch (err: unknown) {
          const error = err as { code?: string }
          if (error.code === 'EXDEV' || error.code === 'EINVAL') {
            // Cross-device move failed, fall back to copy-and-delete
            copyFileSync(tempPath, dest)
            rmSync(tempPath)
          } else {
            throw err
          }
        }
      }
    } finally {
      if (existsSync(tempPath)) {
        rmSync(tempPath)
      }
    }
  }
}

let lastProgress: number | null = null
let lastContext: string | null = null

/**
 * Polls the generate task API until the task is completed.
 */
async function poll(
  id: string,
  apiUrl: string,
  apiKey: string,
  onProgress?: (info: GenerateProgressInfo) => void
): Promise<GenerateTask> {
  while (true) {
    const res = await got(`${apiUrl}/generate_tasks/${id}`, {
      responseType: 'json',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    const task = res.body as GenerateTask

    if (task.completed) {
      updateProgress({ progress: 100 }, onProgress)
      return task
    } else if (task.error) {
      throw new Error(task.error)
    } else {
      updateProgress(task, onProgress)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

function updateProgress(
  task: { progress?: number; context?: string; phase?: string },
  onProgress?: (info: GenerateProgressInfo) => void
): void {
  if (!onProgress) return

  if (task.progress !== lastProgress || task.context !== lastContext) {
    onProgress({ percentComplete: task.progress ?? 0, status: task.context, phase: task.phase })
    lastProgress = task.progress ?? null
    lastContext = task.context ?? null
  }
}

/**
 * Unzips a file to a target directory.
 */
async function unzipFile(path: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const zip = new AdmZip(path)
      zip.extractAllTo(target, true) // true = overwrite existing files
      resolve()
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Downloads a file from a URL and saves it to a path.
 */
function download(url: string, path: string): Promise<void> {
  // ensure the directory exists
  const dir = dirname(path)

  if (dir !== '.') {
    mkdirSync(dir, { recursive: true })
  }

  return new Promise((resolve, reject) => {
    const out = createWriteStream(path)
    got.stream(url).pipe(out)
    out.on('finish', resolve)
    out.on('error', reject)
  })
}
