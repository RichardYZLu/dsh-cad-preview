#!/usr/bin/env node
/**
 * Stability stress run: does a heavy model still take the application down?
 *
 * This is the suite that answers "用着用着会不会崩", and it exists because of a
 * real incident: 0.3.1 shipped a load effect that re-ran itself, and every
 * iteration tessellated the file **on the page's main thread** — 1.8–2.2 s of a
 * dead UI, over and over, until the renderer died and DSH Desktop came up in
 * Safe Mode. `pnpm test` cannot see that: it runs in Node, where there is no
 * main thread to block and no worker to hang.
 *
 * What it measures, per scenario, against the **built** artifacts
 * (`lib/client.worker.js`, `lib/occt-import-js.wasm`) served next to
 * `test/stress/harness.html`:
 *
 *   1. the meter itself can see a blocked main thread (a deliberate busy-wait);
 *   2. a worker parse leaves the main thread responsive — asserted against a
 *      hard ceiling, whatever the model costs;
 *   3. the worker answers at all (no report within the timeout = a hang = FAIL);
 *   4. cancelling/closing a tab releases the kernel (page heap does not climb);
 *   5. the triangle cap reports instead of dying;
 *   6. three workers parse in parallel without touching the main thread;
 *   7. the old in-page path *does* block the main thread — the contrast that
 *      justifies the worker, and a second check on the meter.
 *
 * Usage:
 *   pnpm stress                                   # fast, on the shipped cone
 *   pnpm stress --model <heavy.step>              # the real thing
 *   pnpm stress --preset a|b                      # generate + run a heavy preset
 *   pnpm stress --json | --keep | --timeout 300 | --chrome <path>
 *
 * Caveats, stated up front: `performance.memory` is the *page's* heap, so the
 * worker's own wasm heap is invisible here (that needs renderer RSS, which the
 * DSH sandbox denies); and a headless run never uploads geometry to a GPU.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

const CHROME = argOf('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const asJson = argv.includes('--json')
const keepTemp = argv.includes('--keep')
const scenarioTimeoutMs = Number(argOf('--timeout', '180')) * 1000

/** Chrome flags that make the measurement mean something. */
const CHROME_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  // `performance.memory` needs this to be anything but a coarse lie.
  '--enable-precise-memory-info',
  // `window.gc()` for the heap-after-collection readings.
  '--js-flags=--expose-gc',
  // A throttled background timer would look exactly like a blocked main thread.
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  // NOT --virtual-time-budget: it replaces the clock, starves the emscripten
  // scheduler, and fakes a worker hang. It cost a whole afternoon once.
]

// ── preflight ────────────────────────────────────────────────────────────────
const artifacts = {
  worker: join(root, 'lib', 'client.worker.js'),
  wasm: join(root, 'lib', 'occt-import-js.wasm'),
  glue: join(root, 'lib', 'client.occt.js'),
  harness: join(root, 'test', 'stress', 'harness.html'),
}
for (const [name, path] of Object.entries(artifacts)) {
  if (!existsSync(path)) {
    console.error(`缺少 ${name}：${path}\n先跑 pnpm run build。`)
    process.exit(2)
  }
}
if (!existsSync(CHROME)) {
  console.log(`  skip  压测（找不到 Chrome：${CHROME}；用 --chrome 指定，或跳过这一项）`)
  process.exit(0)
}

/** Resolve the model: --model wins, then --preset (generating it if needed). */
async function resolveModel() {
  const explicit = argOf('--model', '')
  if (explicit !== '') {
    const path = resolve(explicit)
    if (!existsSync(path)) {
      console.error(`--model 指向的文件不存在：${path}`)
      process.exit(2)
    }
    return path
  }
  const preset = argOf('--preset', '')
  if (preset !== '') {
    const grids = { a: 12, b: 17 }
    if (grids[preset] === undefined) {
      console.error(`未知 preset "${preset}"（可用：a, b）`)
      process.exit(2)
    }
    const dir = join(root, 'test', 'fixtures', 'stress')
    const expected = join(dir, `stress-${preset}-${grids[preset] ** 3}spheres.step`)
    if (!existsSync(expected)) {
      console.log(`[stress] ${expected} 不存在，先用 FreeCAD 生成（约 1 分钟）…`)
      await new Promise((resolveGeneration, rejectGeneration) => {
        const child = spawn(process.execPath, [join(root, 'scripts', 'make-stress-fixtures.mjs'), '--preset', preset], { stdio: 'inherit' })
        child.on('exit', (code) => (code === 0 ? resolveGeneration() : rejectGeneration(new Error(`生成失败（exit ${code}）`))))
      }).catch((error) => {
        console.error(String(error?.message ?? error))
        process.exit(2)
      })
    }
    if (!existsSync(expected)) {
      console.error(`生成后仍然找不到 ${expected}`)
      process.exit(2)
    }
    return expected
  }
  return join(root, 'test', 'fixtures', 'cone-r50-h120.step')
}
const modelPath = await resolveModel()
const modelName = modelPath.split('/').pop()

// ── one static server, one Chrome per scenario ──────────────────────────────
let deliver = null
const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/result') {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const report = (() => {
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (error) {
          return { harnessError: `unparseable report: ${String(error?.message ?? error)}` }
        }
      })()
      response.writeHead(204).end()
      if (deliver !== null) {
        const resolve = deliver
        deliver = null
        resolve(report)
      }
    })
    return
  }
  const routes = {
    '/harness.html': artifacts.harness,
    '/client.worker.js': artifacts.worker,
    '/client.occt.js': artifacts.glue,
    '/occt-import-js.wasm': artifacts.wasm,
    '/model.step': modelPath,
  }
  const file = request.url === '/' ? routes['/harness.html'] : routes[(request.url ?? '').split('?')[0]]
  if (file === undefined || !existsSync(file)) {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, {
    'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream',
    'content-length': statSync(file).size,
  })
  response.end(readFileSync(file))
})

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const tempDirs = []

/**
 * Run one scenario: launch Chrome on the harness URL and wait for its report.
 *
 * @param query - harness query string, e.g. `mode=probe&file=model.step`.
 * @returns the reported object, or `{ hang: true }` when the page never came
 *   back — which is a failure, because a worker that never answers is exactly
 *   the regression this suite is for.
 */
function runScenario(query) {
  return new Promise((resolve) => {
    const userDataDir = join(tmpdir(), `dsh-cad-stress-${process.pid}-${tempDirs.length}`)
    tempDirs.push(userDataDir)
    const url = `http://127.0.0.1:${port}/harness.html?${query}`
    const child = spawn(CHROME, [...CHROME_FLAGS, `--user-data-dir=${userDataDir}`, url], { stdio: 'ignore' })
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      deliver = null
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      // Chrome's helpers do not always follow their parent down.
      try { spawn('pkill', ['-f', userDataDir], { stdio: 'ignore' }) } catch { /* best effort */ }
      setTimeout(() => resolve(result), 150)
    }
    const timer = setTimeout(() => finish({ hang: true, timeoutMs: scenarioTimeoutMs }), scenarioTimeoutMs)
    deliver = (report) => finish(report)
    child.on('exit', () => {
      if (!done) finish({ chromeExited: true })
    })
  })
}

const number = (value) => (typeof value === 'number' ? value : Number.NaN)
const fmt = (value, unit = '') => (Number.isFinite(value) ? `${Math.round(value * 10) / 10}${unit}` : '?')

// ── scenarios ────────────────────────────────────────────────────────────────
const scenarios = [
  {
    label: '主线程卡顿探针本身可信（故意阻塞 300ms）',
    query: 'mode=busywait&ms=300',
    verify: (report) => {
      const gap = number(report.maxMainThreadGap)
      return {
        ok: gap >= 250,
        detail: `测得卡顿 ${fmt(gap, 'ms')}（阻塞 300ms）${gap < 250 ? ' —— 探针失效，下面的数字都不能信' : ''}`,
      }
    },
  },
  {
    label: 'worker 解析期间主线程跟手',
    query: 'mode=probe',
    verify: (report) => {
      const gap = number(report.maxMainThreadGap)
      const triangles = number(report.triangles)
      const detail =
        `${fmt(number(report.parseMs) / 1000, 's')} 解析 · 主线程最大卡顿 ${fmt(gap, 'ms')} · ` +
        `${Number.isFinite(triangles) ? triangles.toLocaleString('en-US') : '?'} 面 · payload ${fmt(report.payloadMB, 'MB')}`
      if (report.error !== undefined) return { ok: false, detail: `worker 报错：${report.error}` }
      if (!Number.isFinite(triangles) || triangles <= 0) return { ok: false, detail: `没有三角面（${detail}）` }
      return { ok: gap <= 150, detail }
    },
  },
  {
    label: '取消/关闭标签能把内核还回去（连续 5 次）',
    query: 'mode=abort&n=5',
    verify: (report) => {
      const before = number(report.heapBeforeMB)
      const after = number(report.heapAfterGcMB)
      const growth = after - before
      return {
        ok: Number.isFinite(growth) && growth <= 32,
        detail: `页面堆 ${fmt(before, 'MB')} → ${fmt(after, 'MB')}（增长 ${fmt(growth, 'MB')}，上限 32MB）`,
      }
    },
  },
  {
    label: '面数上限是报错而不是崩',
    query: 'mode=guard&maxtri=1000',
    verify: (report) => {
      const message = String(report.error ?? '')
      // The cap is checked *after* tessellation, so reaching this error costs a
      // full parse — that is a known trade-off, not a bug.
      return {
        ok: /网格太大/.test(message),
        detail: message === '' ? '没有报错，上限似乎没生效' : `优雅报错：${message.slice(0, 60)}…`,
      }
    },
  },
  {
    label: '3 个 worker 并发解析，主线程仍不卡',
    query: 'mode=conc&w=3',
    verify: (report) => {
      const gap = number(report.maxMainThreadGap)
      const counts = Array.isArray(report.triangles) ? report.triangles : []
      return {
        ok: gap <= 150 && counts.length === 3 && counts.every((count) => number(count) > 0),
        detail: `墙钟 ${fmt(number(report.wallMs) / 1000, 's')} · 主线程最大卡顿 ${fmt(gap, 'ms')} · 三份 ${counts.map((c) => Number(c).toLocaleString('en-US')).join(' / ') || '无结果'}`,
      }
    },
  },
  {
    label: '对照：旧路径（页面主线程）确实会锁死界面',
    query: 'mode=baseline',
    verify: (report) => {
      const gap = number(report.maxMainThreadGap)
      const parseMs = number(report.parseMs)
      return {
        ok: parseMs >= 20 && gap >= parseMs * 0.5,
        detail: `同一次解析：主线程卡死 ${fmt(gap, 'ms')} / 解析本身 ${fmt(parseMs, 'ms')}（这也是 0.3.1 每次渲染都在付的代价）`,
      }
    },
  },
]

console.log(`dsh-cad-preview 稳定性压测\n`)
const modelSize = statSync(modelPath).size
console.log(`  模型  ${modelName}  (${modelSize < 1024 * 1024 ? `${(modelSize / 1024).toFixed(1)} KB` : `${(modelSize / 1048576).toFixed(2)} MB`})`)
console.log(`  产物  lib/client.worker.js · lib/occt-import-js.wasm（构建产物，不是替身）`)
console.log(`  浏览器 ${CHROME}\n`)

const results = []
for (const scenario of scenarios) {
  const report = await runScenario(scenario.query)
  if (report.hang === true) {
    results.push({ label: scenario.label, ok: false, detail: `${fmt(scenarioTimeoutMs / 1000, 's')} 内没有回包 —— worker 卡死（这正是要抓的回归）` })
    continue
  }
  if (report.chromeExited === true) {
    results.push({ label: scenario.label, ok: false, detail: 'Chrome 在回包前退出（渲染进程崩了？）' })
    continue
  }
  if (report.harnessError !== undefined) {
    results.push({ label: scenario.label, ok: false, detail: `harness 出错：${report.harnessError}` })
    continue
  }
  const verdict = (() => {
    try {
      return scenario.verify(report)
    } catch (error) {
      return { ok: false, detail: `校验抛错：${String(error?.message ?? error)}` }
    }
  })()
  results.push({ label: scenario.label, ok: verdict.ok, detail: verdict.detail })
}

for (const entry of results) {
  console.log(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.label}`)
  console.log(`         ${entry.detail}`)
}
const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)

if (asJson) console.log(JSON.stringify({ model: modelPath, results }, null, 2))

// ── cleanup ──────────────────────────────────────────────────────────────────
server.close()
if (!keepTemp) {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Chrome may still hold it */ }
  }
} else {
  console.log(`\n临时 profile 保留在：${tempDirs.join('\n')}`)
}

if (failed.length > 0) {
  console.log('\n有失败项。解析期间主线程必须保持跟手；worker 不回包或页面堆持续爬升都算回归。')
  process.exit(1)
}
console.log('\n稳定性判据全部满足：解析不占主线程、取消能回收、上限只报错。')
console.log('注意：这里看不到 worker 自身的 wasm 堆（要 RSS），也没有真正的 GPU 上传。')
