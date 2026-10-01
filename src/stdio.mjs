/**
 * stdio mode: Core hosts this process as a child and forwards OpenAI-shaped
 * requests over newline-delimited JSON, so the plugin opens no port.
 *
 * Core → child:  {"id","method","url","headers","body"}
 * child → Core:  {"id","type":"head","status","headers"}
 *                {"id","type":"chunk","data"}
 *                {"id","type":"end"} | {"id","type":"error","error"}
 */
import { loadAuth, loadCoreSettings, getSettings } from './auth.mjs'
import { probe } from './deepseek.mjs'
import { modelsPayload, openaiStream, openaiJSON } from './openai.mjs'

// Read the settings the user configured in Core, and refresh periodically so a
// token change in the WebUI takes effect without restarting the child.
await loadCoreSettings().catch(() => {})
setInterval(() => { void loadCoreSettings() }, 60000).unref()

// Login-state probe (zero-quota users/current), honouring probe_interval_ms.
let lastProbe = Date.now()
setInterval(() => {
  const interval = getSettings().probeIntervalMs
  if (!interval || interval <= 0 || Date.now() - lastProbe < interval) return
  lastProbe = Date.now()
  const auth = loadAuth()
  if (!auth) return
  probe(auth)
    .then((account) => process.stderr.write(`[deepseek-web] probe ok: ${account}\n`))
    .catch((error) => process.stderr.write(`[deepseek-web] probe failed: ${error?.message || error}\n`))
}, 60000).unref()

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const head = (id, status, headers = {}) => write({ id, type: 'head', status, headers })
const chunk = (id, data) => write({ id, type: 'chunk', data })
const end = (id) => write({ id, type: 'end' })

async function handle(request) {
  const id = request.id
  const method = String(request.method || 'GET').toUpperCase()
  const path = String(request.url || '/').split('?')[0]
  let body = {}
  if (request.body) {
    try {
      body = JSON.parse(request.body)
    } catch {
      body = {}
    }
  }
  try {
    if (method === 'GET' && path === '/v1/models') {
      head(id, 200, { 'content-type': 'application/json' })
      chunk(id, JSON.stringify(modelsPayload()))
      end(id)
      return
    }
    if (method === 'POST' && path === '/v1/probe') {
      const auth = loadAuth()
      head(id, 200, { 'content-type': 'application/json' })
      let payload
      if (!auth) payload = { ok: false, error: 'not logged in' }
      else {
        try {
          payload = { ok: true, account: await probe(auth) }
        } catch (error) {
          payload = { ok: false, error: String(error?.message || error) }
        }
      }
      chunk(id, JSON.stringify(payload))
      end(id)
      return
    }
    if (method === 'POST' && path === '/v1/chat/completions') {
      const auth = loadAuth()
      if (!auth) {
        head(id, 401, { 'content-type': 'application/json' })
        chunk(id, JSON.stringify({ error: { message: 'DeepSeek web is not logged in' } }))
        end(id)
        return
      }
      if (body.stream) {
        head(id, 200, { 'content-type': 'text/event-stream; charset=utf-8' })
        for await (const sse of openaiStream(auth, body)) chunk(id, sse)
      } else {
        const json = await openaiJSON(auth, body)
        head(id, 200, { 'content-type': 'application/json' })
        chunk(id, JSON.stringify(json))
      }
      end(id)
      return
    }
    head(id, 404, {})
    end(id)
  } catch (error) {
    write({ id, type: 'error', error: String(error?.message || error) })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  buffer += data
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    void handle(request)
  }
})
process.stdin.on('end', () => process.exit(0))
