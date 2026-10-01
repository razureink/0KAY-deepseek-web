/**
 * DeepSeek web (chat.deepseek.com) client — a minimal, standalone port of the
 * request/PoW/SSE flow from cv-superding/dsh-deepseek-web-login (Apache-2.0).
 * It speaks the private web endpoints directly as the logged-in browser would:
 * no API key, no DOM, no reverse proxy.
 */

import { getSettings } from './auth.mjs'
import { acquire as acquireThrottle, release as releaseThrottle } from './throttle.mjs'

export const DS_BASE = 'https://chat.deepseek.com'
export const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'
const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const TERMINAL = new Set(['。', '！', '？', '!', '?', '.', '」', '』', '”', '’', ')', '）', '】', '》'])
const CONTINUING = new Set(['，', ',', '、', '；', ';', '：', ':'])

/** Best-effort: a reply that stops on a comma/colon is probably truncated. */
function looksTruncated(text) {
  const trimmed = String(text || '').trimEnd()
  if (!trimmed) return false
  const last = trimmed[trimmed.length - 1]
  if (CONTINUING.has(last)) return true
  return !TERMINAL.has(last)
}

/** Cap the prompt; keep the head (system/tools) and the most recent turns. */
function clampPrompt(prompt, maxChars) {
  if (!maxChars || maxChars <= 0 || prompt.length <= maxChars) return prompt
  const head = Math.floor(maxChars * 0.4)
  const tail = maxChars - head
  return `${prompt.slice(0, head)}\n\n[... middle of the conversation omitted ...]\n\n${prompt.slice(prompt.length - tail)}`
}

export function buildHeaders(auth, referer) {
  const headers = {
    'user-agent': auth.userAgent || FALLBACK_UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    origin: DS_BASE,
    referer: referer || `${DS_BASE}/`,
    'x-client-platform': 'web',
    'x-client-version': '2.0.0',
    'x-app-version': '2.0.0',
    ...(auth.extraHeaders || {}),
  }
  headers.authorization = `Bearer ${auth.token}`
  headers['user-agent'] = auth.userAgent || headers['user-agent'] || FALLBACK_UA
  delete headers['x-ds-pow-response']
  if (auth.cookie) headers.cookie = auth.cookie
  if (auth.hifDliq) headers['x-hif-dliq'] = auth.hifDliq
  if (auth.hifLeim) headers['x-hif-leim'] = auth.hifLeim
  return headers
}

/** The web endpoints signal business errors inside a 200 envelope. */
export function envelopeError(json) {
  if (!json || typeof json !== 'object') return undefined
  if (typeof json.code === 'number' && json.code !== 0) {
    return { code: json.code, msg: String(json.msg ?? json.message ?? 'unknown error') }
  }
  const bizCode = json.data?.biz_code
  if (typeof bizCode === 'number' && bizCode !== 0) {
    return { code: bizCode, msg: String(json.data?.biz_msg ?? 'unknown error') }
  }
  return undefined
}

function checkedWasmUrl(raw) {
  if (typeof raw !== 'string' || !raw) return undefined
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return undefined
  const host = url.hostname.toLowerCase()
  if (host !== 'deepseek.com' && !host.endsWith('.deepseek.com')) return undefined
  if (!url.pathname.toLowerCase().endsWith('.wasm')) return undefined
  return url.href
}

let wasmCache = null
async function solvePoW(challenge, wasmUrl, signal) {
  const url = checkedWasmUrl(wasmUrl) || checkedWasmUrl(DEFAULT_WASM_URL)
  if (!url) throw new Error('invalid PoW WASM url')
  if (!wasmCache || wasmCache.url !== url) {
    const resp = await fetch(url, { signal, redirect: 'error' })
    if (!resp.ok) throw new Error(`PoW WASM fetch HTTP ${resp.status}`)
    const module = await WebAssembly.compile(await resp.arrayBuffer())
    wasmCache = { url, promise: Promise.resolve(module) }
  }
  const module = await wasmCache.promise
  const instance = await WebAssembly.instantiate(module, { wbg: {} })
  const e = instance.exports
  if (typeof e.wasm_solve !== 'function' || typeof e.__wbindgen_export_0 !== 'function' || !e.memory) {
    throw new Error('PoW WASM exports missing')
  }
  const enc = new TextEncoder()
  const cBytes = enc.encode(challenge.challenge)
  const pBytes = enc.encode(`${challenge.salt}_${challenge.expire_at}_`)
  const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0
  const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0
  const mem = new Uint8Array(e.memory.buffer)
  mem.set(cBytes, cP)
  mem.set(pBytes, pP)
  const sp = e.__wbindgen_add_to_stack_pointer(-16)
  e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, Number(challenge.difficulty))
  const dv = new DataView(e.memory.buffer)
  const code = dv.getInt32(sp, true)
  const answer = dv.getFloat64(sp + 8, true)
  e.__wbindgen_add_to_stack_pointer(16)
  if (code === 0 || !Number.isFinite(answer) || answer <= 0) throw new Error(`PoW solve failed (code=${code})`)
  return Math.floor(answer)
}

async function powHeader(auth, targetPath, signal) {
  const resp = await fetch(`${DS_BASE}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: buildHeaders(auth),
    body: JSON.stringify({ target_path: targetPath }),
    signal,
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`PoW challenge HTTP ${resp.status}: ${text.slice(0, 160)}`)
  const json = JSON.parse(text)
  const biz = envelopeError(json)
  if (biz) throw new Error(`PoW challenge: ${biz.msg} (${biz.code})`)
  const challenge = json?.data?.biz_data?.challenge
  if (!challenge?.challenge || !challenge?.salt || !challenge?.signature) {
    throw new Error('PoW challenge missing fields (login may have expired)')
  }
  const answer = await solvePoW(challenge, auth.wasmUrl, signal)
  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: targetPath,
    }),
  ).toString('base64')
}

async function createSession(auth, signal) {
  const resp = await fetch(`${DS_BASE}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: buildHeaders(auth),
    body: '{}',
    signal,
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`session create HTTP ${resp.status}: ${text.slice(0, 160)}`)
  const json = JSON.parse(text)
  const biz = envelopeError(json)
  if (biz) throw new Error(`session create: ${biz.msg} (${biz.code})`)
  const id = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id
  if (!id) throw new Error('session create missing id')
  return id
}

async function deleteSession(auth, sessionId, signal) {
  try {
    await fetch(`${DS_BASE}/api/v0/chat_session/delete`, {
      method: 'POST',
      headers: buildHeaders(auth),
      body: JSON.stringify({ chat_session_id: sessionId }),
      signal,
    })
  } catch {
    /* best effort */
  }
}

/**
 * Upload one image to DeepSeek's web file endpoint and return its file id,
 * for use in the completion request's `ref_file_ids`.
 */
export async function uploadImageFile(auth, { bytes, mime = 'image/png', name = 'image.png' }, signal) {
  const targetPath = '/api/v0/file/upload_file'
  const pow = await powHeader(auth, targetPath, signal)
  const headers = buildHeaders(auth)
  delete headers['content-type'] // let fetch set the multipart boundary
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), name)
  const resp = await fetch(`${DS_BASE}${targetPath}`, {
    method: 'POST',
    headers: { ...headers, 'x-ds-pow-response': pow },
    body: form,
    signal,
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`image upload HTTP ${resp.status}: ${text.slice(0, 160)}`)
  const json = JSON.parse(text)
  const biz = envelopeError(json)
  if (biz) throw new Error(`image upload: ${biz.msg} (${biz.code})`)
  const id = json?.data?.biz_data?.id ?? json?.data?.id
  if (!id) throw new Error('image upload missing file id')
  return String(id)
}

/**
 * Verify the login by reading the read-only `users/current` endpoint (zero quota).
 * Returns the masked account value when valid.
 */
export async function probe(auth, signal) {
  const resp = await fetch(`${DS_BASE}/api/v0/users/current`, { headers: buildHeaders(auth), signal })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`users/current HTTP ${resp.status}`)
  const json = JSON.parse(text)
  const biz = envelopeError(json)
  if (biz) throw new Error(`users/current: ${biz.msg} (${biz.code})`)
  const user = json?.data?.biz_data?.user || json?.data?.biz_data
  return String(user?.email || user?.mobile_number || user?.id || 'ok')
}

/**
 * Run one completion against the web endpoint and stream `{thinking, text}`
 * deltas. Full-transcript mode: `parent_message_id` stays null.
 */
const chains = new Map()

export async function* streamCompletion(auth, { prompt, thinking = false, modelType = 'default', signal, refFileIds = [], sessionKey = '' }) {
  const config = getSettings()
  let currentPrompt = clampPrompt(prompt, config.maxPromptChars)
  let parentMessageId = null
  if (config.contextMode === 'chained' && sessionKey) {
    const chain = chains.get(sessionKey)
    if (chain && typeof chain.prompt === 'string' && prompt.startsWith(chain.prompt) && prompt.length > chain.prompt.length && chain.messageId) {
      const delta = prompt.slice(chain.prompt.length).trim()
      if (delta) {
        currentPrompt = delta
        parentMessageId = chain.messageId
      }
    }
  }
  let firstResponseMessageId = ''
  for (let continuation = 0; ; continuation++) {
    const release = await acquireThrottle(config)
    let sessionId
    let text = ''
    try {
      sessionId = await createSession(auth, signal)
      const pow = await powHeader(auth, '/api/v0/chat/completion', signal)
      const resp = await fetch(`${DS_BASE}/api/v0/chat/completion`, {
        method: 'POST',
        headers: {
          ...buildHeaders(auth, `${DS_BASE}/a/chat/s/${sessionId}`),
          accept: 'text/event-stream',
          'x-ds-pow-response': pow,
        },
        body: JSON.stringify({
          chat_session_id: sessionId,
          parent_message_id: parentMessageId,
          prompt: currentPrompt,
          ref_file_ids: refFileIds,
          thinking_enabled: thinking,
          search_enabled: false,
          model_type: modelType,
          action: null,
          preempt: false,
        }),
        signal,
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`completion HTTP ${resp.status}: ${body.slice(0, 160)}`)
      }
      for await (const delta of parseSSE(resp.body, config.idleTimeoutMs, signal, (meta) => {
        if (!firstResponseMessageId && meta?.messageId) firstResponseMessageId = meta.messageId
      })) {
        if (delta.text) text += delta.text
        yield delta
      }
    } finally {
      if (sessionId && config.sessionCleanup !== 'keep') await deleteSession(auth, sessionId, signal)
      releaseThrottle()
    }
    if (config.contextMode === 'chained' && sessionKey && firstResponseMessageId) {
      chains.set(sessionKey, { prompt, messageId: firstResponseMessageId })
    }
    if (!config.autoContinue || continuation >= config.maxContinuations || !looksTruncated(text)) return
    parentMessageId = null
    currentPrompt = `${currentPrompt}\n\n[Assistant's partial answer]\n${text}\n\n[Continue exactly from where you stopped; do not repeat what you already wrote.]`
  }
}

/** Read the next chunk, aborting when the stream stalls past idleMs. */
async function readWithIdle(reader, idleMs, signal) {
  if (!idleMs || idleMs <= 0) return reader.read()
  let timer
  const idle = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DeepSeek stream idle timeout')), idleMs)
  })
  try {
    return await Promise.race([reader.read(), idle])
  } finally {
    clearTimeout(timer)
  }
}

/** Parse DeepSeek's SSE patch stream into {thinking, text} deltas. */
export async function* parseSSE(body, idleMs = 0, signal, onMeta) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastType = 'RESPONSE'
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const { value, done } = await readWithIdle(reader, idleMs, signal)
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let frame
        try {
          frame = JSON.parse(payload)
        } catch {
          continue
        }
        if (onMeta && (frame.response_message_id || frame.message_id)) {
          onMeta({ messageId: String(frame.response_message_id || frame.message_id) })
        }
        for (const delta of frameDeltas(frame, () => lastType, (t) => { lastType = t })) yield delta
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
}

function frameDeltas(frame, getLast, setLast) {
  const out = []
  const pushFragment = (fragment) => {
    if (!fragment || typeof fragment !== 'object') return
    const type = String(fragment.type || '').toUpperCase()
    if (type === 'THINK' || type === 'THINKING') setLast('THINK')
    else if (type) setLast('RESPONSE')
    if (typeof fragment.content === 'string' && fragment.content) {
      out.push(getLast() === 'THINK' ? { thinking: fragment.content } : { text: fragment.content })
    }
  }
  const appendValue = (value) => {
    if (typeof value === 'string' && value) {
      out.push(getLast() === 'THINK' ? { thinking: value } : { text: value })
    }
  }

  if (typeof frame.v === 'string') {
    appendValue(frame.v)
    return out
  }
  const path = typeof frame.p === 'string' ? frame.p : ''
  if (path.endsWith('/content') && typeof frame.v === 'string') {
    appendValue(frame.v)
    return out
  }
  if (path.startsWith('response/fragments') && Array.isArray(frame.v)) {
    for (const fragment of frame.v) pushFragment(fragment)
    return out
  }
  if (frame.o === 'APPEND' && frame.v !== undefined) {
    if (Array.isArray(frame.v)) for (const fragment of frame.v) pushFragment(fragment)
    else if (typeof frame.v === 'object') pushFragment(frame.v)
    else appendValue(frame.v)
    return out
  }
  if (typeof frame.v === 'object' && frame.v) pushFragment(frame.v)
  return out
}

/** Serialize OpenAI chat messages into the single prompt the web endpoint expects. */
export function serializePrompt(messages, tools) {
  const lines = []
  for (const message of messages || []) {
    const role = String(message.role || 'user')
    let content = message.content
    if (Array.isArray(content)) {
      content = content
        .map((part) => {
          if (typeof part === 'string') return part
          if (part?.text) return part.text
          if (part?.type === 'image' || part?.image_url || part?.imageUrl) return '[image]'
          return ''
        })
        .join('')
    }
    lines.push(`${role === 'system' ? 'System' : role === 'assistant' ? 'Assistant' : role === 'tool' ? 'Tool' : 'User'}: ${content ?? ''}`)
  }
  if (Array.isArray(tools) && tools.length) {
    lines.push(
      'Tools (reply with a single JSON object {"tool_calls":[{"name":"...","arguments":{...}}]} when you need one): ' +
        JSON.stringify(tools.map((t) => t.function || t)),
    )
  }
  return lines.join('\n\n')
}
