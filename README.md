# Fabricate Client

The official Fabricate client package for JavaScript.

## Installation

```bash
npm install @fabricate-tools/client
```

## Usage

To generate and download data from Fabricate:

```javascript
import { generate } from '@fabricate-tools/client'

await generate({
  // The workspace to use
  workspace: 'Default',

  // The name of the database to generate
  database: 'ecommerce',

  // The format to generate. Should be one of:
  // - 'sql'
  // - 'sqlite'
  // - 'csv'
  // - 'jsonl'
  format: 'sql',

  // The destination to save the data
  dest: './data',

  // Optional: Overwrite the destination if it exists
  overwrite: true,

  // Optional: Generate a single table
  // entity: 'Customers',
})
```

To push data to an existing database:

```javascript
import { generate } from '@fabricate-tools/client'

await generate({
  // The workspace to use
  workspace: 'Default',

  // The name of the database in Fabricate
  database: 'ecommerce',

  // The connection details for the target database
  connection: {
    // The host of the target database
    host: 'host.example.com',

    // The port of the target database
    port: 5432,

    // The name of the target database
    database_name: 'ecommerce',

    // The username for the target database
    username: process.env.FABRICATE_DATABASE_USERNAME,

    // The password for the target database
    password: process.env.FABRICATE_DATABASE_PASSWORD,

    // Whether to use TLS for the connection
    tls: true,
  },
})
```
