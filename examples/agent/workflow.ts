import { runWorkflow } from '../../dist/index.js'
import dotenv from 'dotenv'

dotenv.config()

console.log('Starting workflow...')

const { result, task, downloadFile, downloadAllFiles } = await runWorkflow({
  database: 'agent_api_test',
  workspace: 'API',
  workflow: 'file',
  params: {
    message: 'Hello, world!',
  },
  apiUrl: process.env.FABRICATE_API_URL,
  onProgress: ({ status, message }) => {
    console.log(`[${status}] ${message}`)
  },
})

const destDir = './tmp/workflow_output'

console.log(`Workflow result: (${typeof result}) ${JSON.stringify(result, null, 2)}`)

// List and download files if any were generated
if (task.files && task.files.length > 0) {
  console.log(`\nWorkflow generated ${task.files.length} file(s):`)

  for (const file of task.files) {
    console.log(`  - ${file.name} (${file.content_type}, ${file.size} bytes, id: ${file.id})`)

    // Download a specific file by id
    await downloadFile(file.id, `${destDir}/${file.name}`)
  }

  // Or, download all files to a directory
  // console.log('\nDownloading all files...')
  // await downloadAllFiles(destDir)
  // console.log(`Files downloaded to ${destDir}/`)
}

console.log('Done.')
