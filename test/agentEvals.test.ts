import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { AgentEvalsClient, AgentEvalsError } from '../src/agentEvals.js'

interface RecordedRequest {
  method: string
  url: string
  authorization: string | undefined
  contentType: string | undefined
  body: string
}

interface Route {
  status: number
  // Either a static JSON body or a function producing one per call.
  json?: unknown | ((call: number) => unknown)
  raw?: string
}

// A tiny stub server: routes keyed by "METHOD path" (path without query).
// Records each request so tests can assert on URL/auth/body handling.
async function startServer(routes: Record<string, Route>): Promise<{
  client: AgentEvalsClient
  requests: RecordedRequest[]
  calls: Record<string, number>
  close: () => Promise<void>
}> {
  const requests: RecordedRequest[] = []
  const calls: Record<string, number> = {}

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => (data += chunk))
      req.on('end', () => resolve(data))
    })

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const key = `${req.method} ${url.pathname}`
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body,
    })
    const route = routes[key]
    if (!route) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: `no route for ${key}` }))
      return
    }
    const call = (calls[key] = (calls[key] ?? 0) + 1)
    res.statusCode = route.status
    if (route.raw !== undefined) {
      res.end(route.raw)
      return
    }
    const payload = typeof route.json === 'function' ? (route.json as (c: number) => unknown)(call) : route.json
    res.setHeader('content-type', 'application/json')
    res.end(payload === undefined ? '' : JSON.stringify(payload))
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  const client = new AgentEvalsClient({ apiKey: 'test-key', apiUrl: `http://127.0.0.1:${port}/api/v1` })

  return {
    client,
    requests,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('constructor requires an api key', () => {
  const prev = process.env.FABRICATE_API_KEY
  delete process.env.FABRICATE_API_KEY
  try {
    assert.throws(() => new AgentEvalsClient(), /apiKey is required/)
  } finally {
    if (prev !== undefined) process.env.FABRICATE_API_KEY = prev
  }
})

test('listSuites issues an authorized GET to the versioned path', async () => {
  const server = await startServer({
    'GET /api/v1/projects/p1/suites': {
      status: 200,
      json: [{ id: 's1', project_id: 'p1', suite_id: 'p-s1', name: 'Suite', version: 1 }],
    },
  })
  try {
    const suites = await server.client.listSuites('p1')
    assert.equal(suites.length, 1)
    assert.equal(suites[0].id, 's1')
    assert.equal(server.requests[0].method, 'GET')
    assert.equal(server.requests[0].authorization, 'Bearer test-key')
  } finally {
    await server.close()
  }
})

test('createRun sends a JSON body and returns the run', async () => {
  const server = await startServer({
    'POST /api/v1/projects/p1/runs': { status: 201, json: { id: 'run1', status: 'in_progress' } },
  })
  try {
    const run = await server.client.createRun('p1', { suite_id: 's1', model: 'gpt-x' })
    assert.equal(run.id, 'run1')
    const recorded = server.requests[0]
    assert.equal(recorded.method, 'POST')
    assert.match(recorded.contentType ?? '', /application\/json/)
    assert.deepEqual(JSON.parse(recorded.body), { suite_id: 's1', model: 'gpt-x' })
  } finally {
    await server.close()
  }
})

test('report-only payloads send suite labels and trial-local definitions', async () => {
  const server = await startServer({
    'POST /api/v1/projects/p1/runs': { status: 201, json: { id: 'run1', status: 'in_progress' } },
    'POST /api/v1/runs/run1/trials': { status: 202, json: { id: 'trial1', status: 'completed' } },
  })
  try {
    await server.client.createRun('p1', { suite_name: 'Local suite', model: 'gpt-x' })
    await server.client.reportTrial('run1', {
      task: { key: 'users', input: 'Generate users', tags: ['users'] },
      grader_definitions: [{ name: 'quality', prompt: 'Check the output.', tags: ['users'] }],
      transcript: { messages: [] },
      cache_read_tokens: 10,
      cache_write_5m_tokens: 20,
      cache_write_1h_tokens: 30,
      grade: true,
    })

    assert.deepEqual(JSON.parse(server.requests[0].body), { suite_name: 'Local suite', model: 'gpt-x' })
    assert.deepEqual(JSON.parse(server.requests[1].body), {
      task: { key: 'users', input: 'Generate users', tags: ['users'] },
      grader_definitions: [{ name: 'quality', prompt: 'Check the output.', tags: ['users'] }],
      transcript: { messages: [] },
      cache_read_tokens: 10,
      cache_write_5m_tokens: 20,
      cache_write_1h_tokens: 30,
      grade: true,
    })
  } finally {
    await server.close()
  }
})

test('findSuite matches by name and version without creating', async () => {
  const server = await startServer({
    'GET /api/v1/projects/p1/suites': {
      status: 200,
      json: [
        { id: 's1', project_id: 'p1', suite_id: 'p1a', name: 'Alpha', version: 1 },
        { id: 's2', project_id: 'p1', suite_id: 'p1a', name: 'Alpha', version: 2 },
      ],
    },
  })
  try {
    // No version selector returns the highest-numbered matching version.
    const byName = await server.client.findSuite('p1', { name: 'alpha' })
    assert.equal(byName?.id, 's2')
    const byVersion = await server.client.findSuite('p1', { name: 'Alpha', version: 1 })
    assert.equal(byVersion?.id, 's1')
    const missing = await server.client.findSuite('p1', { name: 'Nope' })
    assert.equal(missing, undefined)
    // All three resolved from list calls; no POST was made.
    assert.ok(server.requests.every((r) => r.method === 'GET'))
  } finally {
    await server.close()
  }
})

test('createSuiteVersion copies a suite version through the version endpoint', async () => {
  const server = await startServer({
    'POST /api/v1/suites/s2/versions': {
      status: 201,
      json: { id: 's3', suite_id: 'p1a', name: 'Alpha', version: 3 },
    },
  })
  try {
    const suite = await server.client.createSuiteVersion('s2')
    assert.equal(suite.id, 's3')
    assert.equal(suite.version, 3)
    assert.equal(server.requests[0].method, 'POST')
    assert.equal(server.requests[0].authorization, 'Bearer test-key')
    assert.equal(server.requests[0].body, '')
  } finally {
    await server.close()
  }
})

test('Fixture and Grader Version methods use their version endpoints', async () => {
  const server = await startServer({
    'POST /api/v1/fixtures/fv2/versions': {
      status: 201,
      json: { id: 'fv3', fixture_id: 'f1', name: 'Store', version: 3, entries: [] },
    },
    'POST /api/v1/grader_definitions/gv2/versions': {
      status: 201,
      json: { id: 'gv3', grader_id: 'g1', name: 'Quality', version: 3, kind: 'llm_judge', tags: [] },
    },
  })
  try {
    const fixture = await server.client.createFixtureVersion('fv2')
    const grader = await server.client.createGraderVersion('gv2')
    assert.equal(fixture.fixture_id, 'f1')
    assert.equal(fixture.version, 3)
    assert.equal(grader.grader_id, 'g1')
    assert.equal(grader.version, 3)
    assert.equal(server.requests[0].url, '/api/v1/fixtures/fv2/versions')
    assert.equal(server.requests[1].url, '/api/v1/grader_definitions/gv2/versions')
  } finally {
    await server.close()
  }
})

test('createRun sends structured Fixture and Grader Version overrides', async () => {
  const server = await startServer({
    'POST /api/v1/projects/p1/runs': { status: 201, json: { id: 'run1', status: 'in_progress' } },
  })
  try {
    await server.client.createRun('p1', {
      suite_id: 's1',
      fixture_overrides: [{ fixture_id: 'fixture-1', fixture_version_id: 'fixture-v2' }],
      grader_overrides: [{ grader_id: 'grader-1', grader_version_id: 'grader-v3' }],
    })
    assert.deepEqual(JSON.parse(server.requests[0].body), {
      suite_id: 's1',
      fixture_overrides: [{ fixture_id: 'fixture-1', fixture_version_id: 'fixture-v2' }],
      grader_overrides: [{ grader_id: 'grader-1', grader_version_id: 'grader-v3' }],
    })
  } finally {
    await server.close()
  }
})

test('non-2xx responses throw a typed AgentEvalsError', async () => {
  const server = await startServer({
    'GET /api/v1/trials/t1': { status: 404, raw: JSON.stringify({ error: 'not found' }) },
  })
  try {
    await assert.rejects(
      () => server.client.getTrial('t1'),
      (error: unknown) => {
        assert.ok(error instanceof AgentEvalsError)
        assert.equal(error.status, 404)
        assert.equal(error.method, 'GET')
        assert.match(error.body, /not found/)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('listRuns forwards the branch filter as a query param', async () => {
  const server = await startServer({
    'GET /api/v1/projects/p1/runs': { status: 200, json: [] },
  })
  try {
    await server.client.listRuns('p1', { branch: 'main' })
    assert.match(server.requests[0].url, /[?&]branch=main/)
  } finally {
    await server.close()
  }
})

test('downloadFixtureDatabase returns authorized SQLite bytes', async () => {
  const server = await startServer({
    'GET /api/v1/fixtures/f1/databases/db1': { status: 200, raw: 'sqlite-bytes' },
  })
  try {
    const data = await server.client.downloadFixtureDatabase('f1', 'db1')
    assert.equal(data.toString('utf8'), 'sqlite-bytes')
    assert.equal(server.requests[0].authorization, 'Bearer test-key')
  } finally {
    await server.close()
  }
})

test('waitForGrading polls until grading settles', async () => {
  const server = await startServer({
    'GET /api/v1/trials/t1': {
      status: 200,
      json: (call) =>
        call < 3
          ? { id: 't1', passed: null, grading: { status: 'in_progress', graders_total: 1, graders_completed: 0, error: null } }
          : { id: 't1', passed: true, grading: { status: 'completed', graders_total: 1, graders_completed: 1, error: null } },
    },
  })
  try {
    const trial = await server.client.waitForGrading('t1', { intervalMs: 1, timeoutMs: 2000 })
    assert.equal(trial.passed, true)
    assert.equal(server.calls['GET /api/v1/trials/t1'], 3)
  } finally {
    await server.close()
  }
})

test('waitForGrading times out when grading never settles', async () => {
  const server = await startServer({
    'GET /api/v1/trials/t1': {
      status: 200,
      json: { id: 't1', passed: null, grading: { status: 'in_progress', graders_total: 1, graders_completed: 0, error: null } },
    },
  })
  try {
    await assert.rejects(() => server.client.waitForGrading('t1', { intervalMs: 1, timeoutMs: 20 }), /Timed out/)
  } finally {
    await server.close()
  }
})

test('uploadAttachment mints an upload then PUTs the bytes, returning the id', async () => {
  let putBody = ''
  const server = await startServer({})
  // Replace the default handler with one that also serves the returned upload_url.
  // Re-create with explicit routes referencing the server's own port.
  await server.close()

  const requests: RecordedRequest[] = []
  const srv = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: data,
      })
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'POST' && url.pathname === '/api/v1/workspaces/WS/agent_evals/uploads') {
        const port = (srv.address() as AddressInfo).port
        res.statusCode = 201
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            upload_id: 'up1',
            upload_url: `http://127.0.0.1:${port}/api/v1/agent_evals/uploads/up1`,
            method: 'PUT',
            max_bytes: 1000,
            expires_at: new Date().toISOString(),
            instructions: 'PUT bytes',
          }),
        )
        return
      }
      if (req.method === 'PUT' && url.pathname === '/api/v1/agent_evals/uploads/up1') {
        putBody = data
        res.statusCode = 200
        res.end('')
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => srv.listen(0, resolve))
  const port = (srv.address() as AddressInfo).port
  const client = new AgentEvalsClient({ apiKey: 'k', apiUrl: `http://127.0.0.1:${port}/api/v1` })

  try {
    const uploadId = await client.uploadAttachment('WS', {
      filename: 'report.csv',
      content_type: 'text/csv',
      data: Buffer.from('a,b\n1,2'),
    })
    assert.equal(uploadId, 'up1')
    assert.equal(putBody, 'a,b\n1,2')
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[1].method, 'PUT')
    assert.equal(requests[1].authorization, 'Bearer k')
    assert.equal(requests[1].contentType, 'text/csv')
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
})
