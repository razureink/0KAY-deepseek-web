/**
 * Request throttle, mirroring the original plugin's anti-throttling knobs:
 * serialise same-account requests and wait a random gap in
 * [minRequestIntervalMs, maxRequestIntervalMs] measured from the previous call.
 */
let lastEnd = 0
let tail = Promise.resolve()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function intervalFor(config) {
  const min = Math.max(0, Number(config.minRequestIntervalMs) || 0)
  const max = Math.max(min, Number(config.maxRequestIntervalMs) || 0)
  return min + Math.floor(Math.random() * (max - min + 1))
}

async function waitGap(config) {
  const gap = intervalFor(config)
  const since = Date.now() - lastEnd
  if (gap > since) await sleep(gap - since)
}

/** Resolve when this caller may go; returns a release() to mark the call done. */
export async function acquire(config) {
  if (config.allowConcurrent) {
    await waitGap(config)
    return release
  }
  const previous = tail
  let release
  tail = new Promise((resolve) => { release = resolve })
  await previous
  await waitGap(config)
  return release
}

export function release() {
  lastEnd = Date.now()
}
