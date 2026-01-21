import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'
import got from 'got'

export interface WorkflowProgressInfo {
  status: string
  message: string
}

export interface RunWorkflowOptions {
  apiKey?: string
  apiUrl?: string
  database: string
  workspace: string
  workflow: string
  params?: Record<string, unknown>
  onProgress?: (info: WorkflowProgressInfo) => void
}

export interface WorkflowFile {
  id: number
  name: string
  size: number
  content_type: string
}

export interface WorkflowTask {
  id: string
  workflow_id: string
  status: 'in_progress' | 'completed' | 'failed' | 'canceled'
  result?: unknown
  files?: WorkflowFile[]
  error?: string
  started_at?: string
  completed_at?: string
  created_at: string
}

export interface WorkflowResult {
  result: unknown
  task: WorkflowTask
  /**
   * Downloads a file from the workflow task.
   * @param fileId The ID of the file to download (from task.files[].id)
   * @param destPath The destination path to save the file
   */
  downloadFile: (fileId: number, destPath: string) => Promise<void>
  /**
   * Downloads all files from the workflow task to a directory.
   * @param destDir The destination directory to save the files
   */
  downloadAllFiles: (destDir: string) => Promise<void>
}

export interface DownloadWorkflowFileOptions {
  apiKey?: string
  apiUrl?: string
  taskId: string
  fileId: number
  destPath: string
}

interface StartWorkflowResponse {
  task_id: string
  status: string
}

/**
 * Runs a workflow and waits for the result.
 * @returns A WorkflowResult object containing the result, task, and file download methods.
 */
export default async function runWorkflow({
  apiKey = process.env.FABRICATE_API_KEY,
  apiUrl = process.env.FABRICATE_API_URL || 'https://fabricate.tonic.ai/api/v1',
  database,
  workspace,
  workflow,
  params = {},
  onProgress,
}: RunWorkflowOptions): Promise<WorkflowResult> {
  if (!apiKey) {
    throw new Error('apiKey is required')
  }

  if (!database) {
    throw new Error('database is required')
  }

  if (!workspace) {
    throw new Error('workspace is required')
  }

  if (!workflow) {
    throw new Error('workflow is required')
  }

  let res

  try {
    res = await got.post(
      `${apiUrl}/workspaces/${encodeURIComponent(workspace)}/databases/${encodeURIComponent(database)}/workflows/${encodeURIComponent(workflow)}`,
      {
        responseType: 'json',
        headers: { Authorization: `Bearer ${apiKey}` },
        json: params,
      }
    )
  } catch (e: unknown) {
    const error = e as { response?: { headers?: Record<string, string>; body?: { error?: string } } }
    if (error.response?.headers?.['content-type']?.includes('application/json')) {
      throw new Error(error.response.body?.error || JSON.stringify(error.response.body))
    } else {
      throw e
    }
  }

  const { task_id, status } = res.body as StartWorkflowResponse

  if (!task_id) {
    throw new Error('No task_id returned from API')
  }

  onProgress?.({ status, message: 'Workflow started' })

  // Poll for completion
  const task = await pollWorkflowTask(task_id, apiUrl, apiKey, onProgress)

  if (task.error) {
    throw new Error(task.error)
  }

  // Return a WorkflowResult with download helpers
  return {
    result: task.result,
    task,
    downloadFile: (fileId: number, destPath: string) => {
      return downloadWorkflowFile({ apiKey, apiUrl, taskId: task.id, fileId, destPath })
    },
    downloadAllFiles: async (destDir: string) => {
      if (!task.files || task.files.length === 0) {
        return
      }
      for (const file of task.files) {
        // Sanitize filename to prevent path traversal attacks
        const safeName = basename(file.name)
        const destPath = join(destDir, safeName)
        await downloadWorkflowFile({ apiKey, apiUrl, taskId: task.id, fileId: file.id, destPath })
      }
    },
  }
}

/**
 * Polls the workflow task API until the task is completed.
 */
async function pollWorkflowTask(
  taskId: string,
  apiUrl: string,
  apiKey: string,
  onProgress?: (info: WorkflowProgressInfo) => void
): Promise<WorkflowTask> {
  while (true) {
    const res = await got(`${apiUrl}/workflow_tasks/${taskId}`, {
      responseType: 'json',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    const task = res.body as WorkflowTask

    if (task.status === 'completed') {
      onProgress?.({ status: 'completed', message: 'Workflow completed' })
      return task
    } else if (task.status === 'failed') {
      throw new Error(task.error || 'Workflow failed')
    } else if (task.status === 'canceled') {
      throw new Error('Workflow was canceled')
    } else {
      onProgress?.({ status: task.status, message: 'Workflow running...' })
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

/**
 * Downloads a file from a workflow task.
 */
export async function downloadWorkflowFile({
  apiKey = process.env.FABRICATE_API_KEY,
  apiUrl = process.env.FABRICATE_API_URL || 'https://fabricate.tonic.ai/api/v1',
  taskId,
  fileId,
  destPath,
}: DownloadWorkflowFileOptions): Promise<void> {
  if (!apiKey) {
    throw new Error('apiKey is required')
  }

  if (!taskId) {
    throw new Error('taskId is required')
  }

  if (!fileId) {
    throw new Error('fileId is required')
  }

  if (!destPath) {
    throw new Error('destPath is required')
  }

  // Ensure the directory exists
  const dir = dirname(destPath)
  if (dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const url = `${apiUrl}/workflow_tasks/${taskId}/${fileId}/download`

  return new Promise((resolve, reject) => {
    let settled = false
    const out = createWriteStream(destPath)

    const cleanup = () => {
      try {
        if (existsSync(destPath)) {
          unlinkSync(destPath)
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    const stream = got.stream(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })

    const handleError = (error: Error) => {
      if (settled) return
      settled = true
      stream.destroy()
      out.destroy()
      cleanup()
      reject(error)
    }

    const handleSuccess = () => {
      if (settled) return
      settled = true
      resolve()
    }

    stream.on('response', (response) => {
      if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
        handleError(new Error(`Download failed with status ${response.statusCode}`))
      }
    })

    stream.on('error', handleError)
    out.on('error', handleError)
    out.on('finish', handleSuccess)

    stream.pipe(out)
  })
}
