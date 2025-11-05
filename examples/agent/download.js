import { generate } from '../../index.js'
import dotenv from 'dotenv'

dotenv.config()

console.log('starting...')

await generate({
  database: 'agent_api_test',
  workspace: 'API',
  // format: 'postgres',
  // dest: './tmp/agent_api_test.sql',

  format: 'csv',
  dest: './tmp/agent_api_test',

  overwrite: true,
  apiUrl: process.env.FABRICATE_API_URL,
  onProgress: ({ percentComplete, status, phase }) => {
    console.log(`${phase ? `[${phase}] ` : ''}${percentComplete}% complete${status ? `, ${status}` : ''}...`)
  },

  // Uncomment to generate a single table
  // entity: 'Customers',
})

console.log('done.')
