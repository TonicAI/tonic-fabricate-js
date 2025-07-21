import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import got from 'got'
import AdmZip from 'adm-zip'
import { dirname } from 'path'

/**
 * Generates data for a given database.
 * @returns {Promise<void>}
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
}) {
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

  if (existsSync(dest) && !overwrite) {
    throw new Error('dest already exists')
  }

  let res

  try {
    res = await got.post(`${apiUrl}/generate_tasks`, {
      responseType: 'json',
      headers: { Authorization: `Bearer ${apiKey}` },
      json: { format, connection, database, entity, overrides, workspace },
    })
  } catch (e) {
    if (e.response?.headers?.['content-type'] === 'application/json') {
      throw new Error(e.response.body.error)
    } else {
      throw e
    }
  }

  let task = res.body

  if (task.error) {
    throw new Error(task.error)
  }

  task = await poll(task.id, apiUrl, apiKey, onProgress)

  const { data_url, error } = task

  if (error) {
    console.error('Fabricate API returned an error: ' + error)
    process.exit(1)
  }

  if (connection == null) {
    // Create temp file paths
    const tempPath = `${dest}.tmp`

    try {
      // Download to temp location first
      await download(data_url, tempPath)

      if (unzip && task.content_type === 'application/zip') {
        await unzipFile(tempPath, dest)
      } else {
        renameSync(tempPath, dest)
      }
    } finally {
      if (existsSync(tempPath)) {
        rmSync(tempPath)
      }
    }
  }
}

let lastProgress = null,
  lastContext = null

/**
 * Polls the generate task API until the task is completed.
 * @param {string} id - The ID of the task to poll.
 * @returns {Promise<object>} - The task object.
 */
async function poll(id, apiUrl, apiKey, onProgress) {
  while (true) {
    const res = await got(`${apiUrl}/generate_tasks/${id}`, {
      responseType: 'json',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    const task = res.body

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

function updateProgress(task, onProgress) {
  if (!onProgress) return

  if (task.progress !== lastProgress || task.context !== lastContext) {
    onProgress?.({ percentComplete: task.progress, status: task.context, phase: task.phase })
    lastProgress = task.progress
    lastContext = task.context
  }
}

/**
 * Unzips a file to a target directory.
 * @param {string} path - The path to the zip file.
 * @param {string} target - The target directory.
 * @returns {Promise<void>}
 */
async function unzipFile(path, target) {
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
 * @param {string} url - The URL to download from.
 * @param {string} path - The path to save the file to.
 * @returns {Promise<void>}
 */
function download(url, path) {
  // ensure the directory exists
  const dir = dirname(path)

  if (dir !== '.') {
    // delete the directory if it exists
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true })
    }

    mkdirSync(dir, { recursive: true })
  }

  return new Promise((resolve, reject) => {
    const out = createWriteStream(path)
    got.stream(url).pipe(out)
    out.on('finish', resolve)
    out.on('error', reject)
  })
}
