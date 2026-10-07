/**
 * Evaluate the sampler's module the way a browser would, minus the GPU.
 *
 * This exists because the sampler has repeatedly shipped with a wiring mistake —
 * a function deleted by a bad patch, a definition that never got inserted — and
 * each time the only thing that noticed was the reporter's browser. The page has
 * an error panel now, but catching it *before* handing it over is the actual
 * requirement: importing the built bundle here fails on any missing identifier,
 * bad import, or top-level mistake.
 *
 * Run: node scripts/check-samples.mjs
 */
import { installDom } from '../test/support/dom-stub.mjs'
import { createElementStub } from './support/element-stub.mjs'
import { join } from 'node:path'

const root = process.cwd()

// DOM first: the module touches `document` during evaluation.
installDom()

// The sampler looks up several elements by id and mutates them as it wires the
// UI. A generic stub records what it asked for, so a missing id is visible too.
const elements = new Map()
globalThis.document.getElementById = (id) => {
  if (!elements.has(id)) elements.set(id, createElementStub(id))
  return elements.get(id)
}
// Canvases must keep the DOM stub's fake WebGL context, so only non-canvas
// elements go through the generic stub.
const originalCreateElement = globalThis.document.createElement
globalThis.document.createElement = (tag) =>
  tag === 'canvas' ? originalCreateElement(tag) : createElementStub(tag)

// One small model, served from disk: enough to exercise parsing, edge building,
// scale measurement and framing without waiting on the 33 MB skeleton.
const MODEL = '/Volumes/exSSD/DSH/image-production/cad-build/shouzhen-a-geometry/shouzhen-a-geometry.stl'
const MENU = [{ name: 'check', url: '/model/check.stl', bytes: 25084 }]
globalThis.fetch = async (url) => {
  if (String(url) === '/models') {
    return { ok: true, json: async () => MENU }
  }
  const { readFileSync } = await import('node:fs')
  const bytes = readFileSync(MODEL)
  return {
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

const failures = []
const report = (message) => failures.push(message)
// The page installs its own handlers; capture their calls instead of losing them.
globalThis.window.addEventListener = (type, handler) => {
  if (type === 'error') globalThis.__onError = handler
  if (type === 'unhandledrejection') globalThis.__onRejection = handler
}
globalThis.addEventListener = globalThis.window.addEventListener

let outcome = 'ok'
try {
  await import(join(root, 'lib', 'samples.js'))
} catch (error) {
  outcome = 'threw'
  report(`${error?.name ?? 'Error'}: ${error?.message ?? error}`)
}

if (outcome === 'ok') {
  console.log('sampler module evaluated cleanly ✓')
} else {
  console.log(`sampler module failed to evaluate:`)
  for (const failure of failures) console.log(`  ${failure}`)
}

// Every container the bundle looks up must exist in the markup, or the controls
// meant for it are appended to nothing and silently disappear.
{
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(join(root, 'test', 'browser', 'samples.html'), 'utf8')
  const bundle = readFileSync(join(root, 'lib', 'samples.js'), 'utf8')
  const wanted = [...bundle.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1])
  const missing = [...new Set(wanted)].filter((id) => !html.includes(`id="${id}"`))
  if (missing.length > 0) {
    console.log(`containers referenced by the bundle but absent from the page: ${missing.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(`all ${new Set(wanted).size} referenced containers exist in the page ✓`)
  }
}

// The page reports failures through its own panel; surface anything it caught.
const reportElement = elements.get('report')
const shown = reportElement?.innerHTML ?? ''
if (shown.includes('出错了')) {
  console.log(`the page's own error panel shows: ${shown.replace(/<[^>]*>/g, '')}`)
  process.exitCode = 1
}
if (outcome !== 'ok') process.exitCode = 1

// `requestAnimationFrame` in the stub schedules a timer; leave nothing pending.
setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref?.()
