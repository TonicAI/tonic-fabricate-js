import { generate } from '../../dist/index.js'
import dotenv from 'dotenv'

dotenv.config()

console.log('starting...')

await generate({
  database: 'ecommerce',
  workspace: 'Default',
  apiUrl: process.env.FABRICATE_API_URL,
  connection: {
    host: 'localhost',
    port: 5432,
    database_name: 'ecommerce',
    username: process.env.FABRICATE_DATABASE_USERNAME,
    password: process.env.FABRICATE_DATABASE_PASSWORD,
    tls: false,
  },
  onProgress: ({ percentComplete, status, phase }) => {
    console.log(`${phase ? `[${phase}] ` : ''}${percentComplete}% complete${status ? `, ${status}` : ''}...`)
  },
})

console.log('done.')
