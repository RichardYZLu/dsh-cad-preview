#!/usr/bin/env node
/**
 * Render the README screenshots from the appearance sampler.
 *
 * The images in `docs/screenshots/` are produced by this script so they can be
 * regenerated rather than re-taken by hand. It drives the **existing** sampler
 * (`test/browser/samples.mjs`) in a real headless Chrome, which means every
 * image goes through the same `createViewerScene` rig and the same appearance
 * code the sidebar viewer uses — on real CAD exports, not a stand-in cube.
 *
 * Chrome is driven over the DevTools protocol with Node's built-in `WebSocket`
 * and `fetch`, so this adds no dependency.
 *
 * Usage:
 *   node scripts/make-screenshots.mjs                 # all shots
 *   node scripts/make-screenshots.mjs --only building-ao
 *   node scripts/make-screenshots.mjs --out docs/screenshots --keep
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

const CHROME = argOf('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const outDir = join(root, argOf('--out', 'docs/screenshots'))
const only = argOf('--only', null)
const keep = argv.includes('--keep')
const serverPort = Number(argOf('--port', '8123'))
const debugPort = Number(argOf('--debug-port', '9333'))
const width = Number(argOf('--width', '1600'))
const height = Number(argOf('--height', '1000'))
const scale = Number(argOf('--scale', '2'))

/**
 * The shots to take.
 *
 * `model` is the served URL's basename, `variant` is one of the sampler's
 * buttons (`current` / `ao+strong` / `lines`), and `wheel` is an optional
 * DevTools wheel delta — negative dollies in, exactly as a real scroll does
 * (`OrbitRig.onWheel` is `radius *= exp(deltaY * 0.0012)`, so -240 is ≈ ×0.75).
 * Framing is otherwise whatever the viewer's own `fit()` produces, so these
 * images are what opening the file shows, not a staged composition.
 */
const SHOTS = [
  {
    name: 'building-ao',
    model: 'shouzhen-columns-skeleton.stl',
    variant: 'ao+strong',
    caption: '建筑柱网 · ao+strong（默认外观）',
  },
  {
    name: 'building-lines',
    model: 'shouzhen-columns-skeleton.stl',
    variant: 'lines',
    caption: '建筑柱网 · lines（线框）',
  },
  {
    name: 'parts-ao',
    model: 'fupen-samples.stl',
    variant: 'ao+strong',
    wheel: -240,
    caption: '构件样本 · ao+strong（默认外观）',
  },
]

// ── a very small CDP client ──────────────────────────────────────────────────
/** One page target, one socket, request/response by message id. */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`))
      else entry.resolve(message.result)
    })
  }

  /**
   * Connect to one target's debugger URL.
   *
   * @param url - the `webSocketDebuggerUrl` of a page target.
   * @returns a connected client.
   */
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), {
        once: true,
      })
    })
    return new Cdp(socket)
  }

  /** Send one command and await its result. */
  send(method, params = {}) {
    const id = (this.nextId += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Evaluate an expression in the page and return its JSON value.
   *
   * @param expression - a self-contained expression (not a function).
   */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
    }
    return result.result.value
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll `fetch(url)` until it answers, or give up. */
async function waitForHttp(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json().catch(() => ({}))
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${label} did not come up within ${timeoutMs}ms`)
    await sleep(200)
  }
}

/**
 * Wait until the sampler has a model on screen.
 *
 * The panel only names a model once `showModel` has run and edges are built, so
 * its text is the honest "the page is ready to be photographed" signal.
 *
 * @param cdp - the page client.
 * @param model - basename expected in the panel.
 */
async function waitForModel(cdp, model, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await cdp.eval(`(() => {
      const report = document.getElementById('report')
      const text = report ? report.textContent : ''
      return { text, failed: /出错了/.test(text) }
    })()`)
    if (state.failed) throw new Error(`sampler reported: ${state.text}`)
    if (state.text.includes(model) && /三角面/.test(state.text)) return state.text
    if (Date.now() > deadline) throw new Error(`model ${model} never finished loading`)
    await sleep(500)
  }
}

/**
 * Click the sampler's button whose label matches exactly.
 *
 * @param cdp - the page client.
 * @param label - the button text, e.g. `ao+strong`.
 */
async function clickButton(cdp, label) {
  const clicked = await cdp.eval(`(() => {
    const wanted = ${JSON.stringify(label)}
    const button = [...document.querySelectorAll('#variants button')]
      .find((candidate) => candidate.textContent.trim() === wanted)
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error(`no sampler button labelled ${label}`)
}

/** Switch the sampler to another model and wait for it to finish loading. */
async function selectModel(cdp, model) {
  const switched = await cdp.eval(`(() => {
    const select = document.getElementById('models')
    const url = '/model/' + ${JSON.stringify(model)}
    if (![...select.options].some((option) => option.value === url)) return false
    select.value = url
    select.dispatchEvent(new Event('change'))
    return true
  })()`)
  if (!switched) throw new Error(`model ${model} is not in the sampler's menu`)
  await waitForModel(cdp, model)
}

const main = async () => {
  mkdirSync(outDir, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'dsh-cad-shots-'))

  const server = spawn(process.execPath, [join(root, 'test', 'browser', 'samples.mjs'), '--port', String(serverPort)], {
    cwd: root,
    stdio: 'ignore',
  })

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      `--window-size=${width},${height}`,
      // Software WebGL, so the run does not depend on the host's GPU state.
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--no-first-run',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `http://127.0.0.1:${serverPort}/`,
    ],
    { stdio: 'ignore' },
  )

  let cdp
  try {
    await waitForHttp(`http://127.0.0.1:${serverPort}/models`, 'sampler server')
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 'Chrome debugger')

    const targets = await waitForHttp(`http://127.0.0.1:${debugPort}/json/list`, 'Chrome targets')
    const page = (Array.isArray(targets) ? targets : []).find(
      (target) => target.type === 'page' && String(target.url).includes(`:${serverPort}`),
    )
    if (page === undefined) throw new Error('no page target for the sampler')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    // A real renderer is the whole point; fail loudly instead of shipping a
    // flat image of a broken canvas.
    const gl = await cdp.eval(`(() => {
      const canvas = document.querySelector('#stage canvas')
      if (!canvas) return 'no canvas'
      const context = canvas.getContext('webgl2') || canvas.getContext('webgl')
      if (!context) return 'no webgl context'
      const info = context.getExtension('WEBGL_debug_renderer_info')
      return info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.VERSION)
    })()`)
    console.log(`WebGL renderer: ${gl}`)

    await waitForModel(cdp, 'shouzhen-a-geometry.stl')

    // The stats panel floats over the model's top-left corner; it is useful in
    // the sampler and wrong in a screenshot.
    await cdp.eval(`(() => { const el = document.getElementById('report'); if (el) el.style.display = 'none'; return true })()`)

    for (const shot of SHOTS) {
      if (only !== null && only !== shot.name) continue
      await selectModel(cdp, shot.model)
      await clickButton(cdp, shot.variant)
      // Let the orbit loop draw at least one frame with the new look.
      await sleep(1200)

      const box = await cdp.eval(`(() => {
        const rect = document.getElementById('stage').getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`)

      if (shot.wheel !== undefined) {
        // A real wheel event on the canvas, so the rig's own dolly runs.
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          deltaX: 0,
          deltaY: shot.wheel,
        })
        await sleep(600)
      }

      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...box, scale },
      })
      const file = join(outDir, `${shot.name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      const bytes = Buffer.from(data, 'base64').length
      console.log(
        `${shot.name}.png  ${Math.round(box.width)}×${Math.round(box.height)} @${scale}x  ` +
          `${(bytes / 1024).toFixed(0)} KB  — ${shot.caption}`,
      )
    }
  } finally {
    cdp?.close()
    try {
      chrome.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    try {
      server.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    // Chrome's helpers do not always follow their parent down.
    spawn('pkill', ['-f', profile], { stdio: 'ignore' })
    if (!keep) setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500)
  }
}

await main()
