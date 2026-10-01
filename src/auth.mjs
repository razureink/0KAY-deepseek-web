import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Settings the user configured in Core (Settings → DeepSeek 网页版). The plugin
 * has no gRPC channel, so Core registers the section from the manifest and the
 * plugin reads it back. Mirrors the tunables of the original
 * dsh-deepseek-web-login panel (throttle, session cleanup, context, login).
 */
export const DEFAULTS = {
  token: '',
  authFile: '',
  defaultModel: 'deepseek-web-chat',
  maxPromptChars: 400000,
  minRequestIntervalMs: 2000,
  maxRequestIntervalMs: 4000,
  allowConcurrent: false,
  idleTimeoutMs: 120000,
  autoContinue: true,
  maxContinuations: 2,
  sessionCleanup: 'deferred',
  probeIntervalMs: 1800000,
  maxRefImages: 24,
  contextMode: 'full',
}

let settings = { ...DEFAULTS }

function coreBase() {
  return (process.env.DEEPSEEK_WEB_CORE_HTTP || process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080').replace(/\/+$/, '')
}

function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  return fallback
}

function asInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback
}

function asString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/** Pull the settings section from Core (best effort; keeps previous on failure). */
export async function loadCoreSettings() {
  try {
    const res = await fetch(`${coreBase()}/api/settings/deepseek-web`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return
    const values = (await res.json())?.values || {}
    settings = {
      token: asString(values.token, ''),
      authFile: asString(values.auth_file, ''),
      defaultModel: asString(values.default_model, DEFAULTS.defaultModel),
      maxPromptChars: asInt(values.max_prompt_chars, DEFAULTS.maxPromptChars),
      minRequestIntervalMs: asInt(values.min_request_interval_ms, DEFAULTS.minRequestIntervalMs),
      maxRequestIntervalMs: asInt(values.max_request_interval_ms, DEFAULTS.maxRequestIntervalMs),
      allowConcurrent: asBool(values.allow_concurrent, DEFAULTS.allowConcurrent),
      idleTimeoutMs: asInt(values.idle_timeout_ms, DEFAULTS.idleTimeoutMs),
      autoContinue: asBool(values.auto_continue, DEFAULTS.autoContinue),
      maxContinuations: asInt(values.max_continuations, DEFAULTS.maxContinuations),
      sessionCleanup: asString(values.session_cleanup, DEFAULTS.sessionCleanup),
      probeIntervalMs: asInt(values.probe_interval_ms, DEFAULTS.probeIntervalMs),
      maxRefImages: asInt(values.max_ref_images, DEFAULTS.maxRefImages),
      contextMode: asString(values.context_mode, DEFAULTS.contextMode),
    }
  } catch {
    /* keep previous */
  }
}

/** Current settings snapshot. */
export function getSettings() {
  return { ...settings }
}

/** Where the captured DeepSeek web credentials live. */
export function authFilePath() {
  return settings.authFile || process.env.DEEPSEEK_WEB_AUTH_FILE || path.join(os.homedir(), '.dsh', 'web-login', 'deepseek-auth.json')
}

/**
 * Load the DeepSeek web login credentials. Priority: Core settings token →
 * DEEPSEEK_WEB_TOKEN → the DSH plugin's captured auth JSON.
 * Returns null when nothing usable is found.
 */
export function loadAuth() {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(authFilePath(), 'utf8'))
  } catch {
    raw = {}
  }
  if (typeof raw === 'string') raw = { token: raw }
  const bearer = String(raw.token || raw.authorization || raw.accessToken || '').replace(/^Bearer\s+/i, '').trim()
  const token = settings.token.replace(/^Bearer\s+/i, '').trim() || (process.env.DEEPSEEK_WEB_TOKEN || '').replace(/^Bearer\s+/i, '').trim() || bearer
  if (!token) return null
  return {
    token,
    cookie: typeof raw.cookie === 'string' ? raw.cookie : '',
    userAgent: typeof raw.userAgent === 'string' ? raw.userAgent : '',
    hifDliq: raw.hifDliq || raw['x-hif-dliq'] || '',
    hifLeim: raw.hifLeim || raw['x-hif-leim'] || '',
    extraHeaders: raw.extraHeaders && typeof raw.extraHeaders === 'object' ? raw.extraHeaders : {},
    wasmUrl: typeof raw.wasmUrl === 'string' ? raw.wasmUrl : '',
  }
}
