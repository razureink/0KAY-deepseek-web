/**
 * Shared OpenAI-wire helpers for the DeepSeek web adapter, used by both the
 * HTTP server and the stdio bridge.
 */
import { randomUUID } from 'node:crypto'
import { streamCompletion, serializePrompt } from './deepseek.mjs'

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
  const model = String(body.model || MODELS[0].id)
  const prompt = serializePrompt(body.messages, body.tools)
  for await (const delta of streamCompletion(auth, { prompt, thinking: resolveThinking(model), signal: body._signal })) {
    if (delta.thinking) yield chunk(model, { reasoning_content: delta.thinking })
    else if (delta.text) yield chunk(model, { content: delta.text })
  }
  yield chunk(model, {}, 'stop')
  yield 'data: [DONE]\n\n'
}

/** Non-streaming completion as an OpenAI chat.completion object. */
export async function openaiJSON(auth, body) {
  const model = String(body.model || MODELS[0].id)
  const prompt = serializePrompt(body.messages, body.tools)
  let content = ''
  let reasoning = ''
  for await (const delta of streamCompletion(auth, { prompt, thinking: resolveThinking(model), signal: body._signal })) {
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
