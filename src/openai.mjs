/**
 * Shared OpenAI-wire helpers for the DeepSeek web adapter, used by both the
 * HTTP server and the stdio bridge.
 */
import { randomUUID } from 'node:crypto'
import { streamCompletion, serializePrompt, uploadImageFile } from './deepseek.mjs'
import { getSettings } from './auth.mjs'

function dataUrlToImage(url) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url || '')
  if (!match) return null
  const mime = match[1] || 'image/png'
  const bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg')
  return { bytes, mime, name: `image.${ext}` }
}

function collectImages(messages, limit) {
  const out = []
  for (const message of messages || []) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const url = part?.image_url?.url || (part?.type === 'image' ? part?.url || part?.imageUrl : '')
      if (typeof url === 'string' && url.startsWith('data:')) {
        const image = dataUrlToImage(url)
        if (image) out.push(image)
      }
    }
    if (limit && out.length >= limit) return out.slice(0, limit)
  }
  return out
}

/** Upload any inline images and return their DeepSeek file ids. */
async function collectRefFileIds(auth, body) {
  const config = getSettings()
  if (config.maxRefImages === 0) return []
  const images = collectImages(body.messages, config.maxRefImages || 24)
  const ids = []
  for (const image of images) {
    try {
      ids.push(await uploadImageFile(auth, image, body._signal))
    } catch {
      /* skip images that fail to upload */
    }
  }
  return ids
}

export const MODELS = [
  { id: 'deepseek-web-chat', thinking: false },
  { id: 'deepseek-web-reasoner', thinking: true },
]

export function resolveThinking(model) {
  const known = MODELS.find((m) => m.id === model)
  return known ? known.thinking : /reason|think/i.test(model)
}

function chunk(model, delta, finish = null) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

export function modelsPayload() {
  return { object: 'list', data: MODELS.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'deepseek-web' })) }
}

/** Stream an OpenAI-compatible SSE for a chat completion request. */
export async function* openaiStream(auth, body) {
  const model = String(body.model || getSettings().defaultModel || MODELS[0].id)
  const prompt = serializePrompt(body.messages, body.tools)
  const refFileIds = await collectRefFileIds(auth, body)
  const sessionKey = String(body.user || body.session_id || '')
  for await (const delta of streamCompletion(auth, { prompt, thinking: resolveThinking(model), signal: body._signal, refFileIds, sessionKey })) {
    if (delta.thinking) yield chunk(model, { reasoning_content: delta.thinking })
    else if (delta.text) yield chunk(model, { content: delta.text })
  }
  yield chunk(model, {}, 'stop')
  yield 'data: [DONE]\n\n'
}

/** Non-streaming completion as an OpenAI chat.completion object. */
export async function openaiJSON(auth, body) {
  const model = String(body.model || getSettings().defaultModel || MODELS[0].id)
  const prompt = serializePrompt(body.messages, body.tools)
  const refFileIds = await collectRefFileIds(auth, body)
  const sessionKey = String(body.user || body.session_id || '')
  let content = ''
  let reasoning = ''
  for await (const delta of streamCompletion(auth, { prompt, thinking: resolveThinking(model), signal: body._signal, refFileIds, sessionKey })) {
    if (delta.thinking) reasoning += delta.thinking
    else if (delta.text) content += delta.text
  }
  const message = { role: 'assistant', content }
  if (reasoning) message.reasoning_content = reasoning
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}
