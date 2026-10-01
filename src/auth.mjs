import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Settings values the user configured in Core (Settings → DeepSeek 网页版),
 * pushed here by loadCoreSettings(). The plugin has no gRPC channel, so Core
 * registers the section from the manifest and the plugin reads it back.
 */
let coreSettings = { token: '', authFile: '' }

function coreBase() {
  return (process.env.DEEPSEEK_WEB_CORE_HTTP || process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080').replace(/\/+$/, '')
}

/** Pull token / auth_file from Core's settings section (best effort). */
export async function loadCoreSettings() {
  try {
    const res = await fetch(`${coreBase()}/api/settings/deepseek-web`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return
    const data = await res.json()
    const values = data?.values || {}
    coreSettings = {
      token: typeof values.token === 'string' ? values.token.trim() : '',
      authFile: typeof values.auth_file === 'string' ? values.auth_file.trim() : '',
    }
  } catch {
    /* keep the previous values */
  }
}

/** Where the captured DeepSeek web credentials live. */
export function authFilePath() {
  return coreSettings.authFile || process.env.DEEPSEEK_WEB_AUTH_FILE || path.join(os.homedir(), '.dsh', 'web-login', 'deepseek-auth.json')
}

/**
 * Load the DeepSeek web login credentials. Priority: Core settings token →
 * DEEPSEEK_WEB_TOKEN → the DSH plugin's captured auth JSON (a raw token string
 * or an object with token/authorization/cookie/extraHeaders).
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
  const token = coreSettings.token.replace(/^Bearer\s+/i, '').trim() || (process.env.DEEPSEEK_WEB_TOKEN || '').replace(/^Bearer\s+/i, '').trim() || bearer
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
