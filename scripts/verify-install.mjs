#!/usr/bin/env node
/**
 * 重启后自检：在*运行中的* DSH Desktop 上确认 dsh-cad-preview 真的挂上了。
 *
 * 检查四件事：
 *   1. 装了哪个版本；
 *   2. 组合配置里有没有 `# == dsh-cad-preview` 这一层（宿主半边是否注册）；
 *   3. 运行中的 GUI 有没有响应 /cad-preview/ping；
 *   4. 三条路线是否真的可用（bundle / wasm / 模型字节 + Range）。
 *
 * 用法：
 *   node scripts/verify-install.mjs                 # 自动探测端口
 *   node scripts/verify-install.mjs --port 43129
 *   node scripts/verify-install.mjs --model /path/to/part.step
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

const DSH_HOME = join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const APP = '/Applications/DSH Desktop.app'
const NODE = join(DSH_HOME, '.desktop-bin', 'node')
const CLI = join(APP, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const results = []
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === '' ? '' : `\n         ${detail}`}`)
}

console.log('dsh-cad-preview 安装自检\n')

// ── 1. 安装体 ────────────────────────────────────────────────────────────────
const installed = join(PROFILE, 'node_modules', 'dsh-cad-preview')
if (!existsSync(installed)) {
  record(false, '插件已安装', `${installed} 不存在 — 需要 dsh plugin --profile web add <tgz>`)
} else {
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  record(true, `插件版本 ${pkg.version}`, installed)
  for (const asset of ['lib/index.js', 'lib/client.js', 'lib/client.worker.js', 'lib/occt-import-js.wasm']) {
    const path = join(installed, asset)
    record(existsSync(path), `资源存在 ${asset}`, existsSync(path) ? `${(statSync(path).size / 1048576).toFixed(2)} MB` : '缺失')
  }
}

// ── 1b. profile 引用的 tarball 都还在吗 ──────────────────────────────────────
// pnpm 解析依赖图时会读 profile 里记下的每一个 file: 路径；删了任何一个，
// 下一次 `dsh plugin add` 都会以 exit code 254 失败而看不到真实原因。
try {
  const profilePkg = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
  const missing = []
  for (const [name, spec] of Object.entries(profilePkg.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    if (!existsSync(spec.slice('file:'.length))) missing.push(`${name} → ${spec}`)
  }
  record(missing.length === 0, 'profile 引用的本地 tarball 都在', missing.join('\n         '))
} catch (error) {
  record(false, 'profile/package.json 可读', String(error?.message ?? error))
}

// ── 2. 组合配置里的挂载行 ────────────────────────────────────────────────────
if (existsSync(NODE) && existsSync(CLI)) {
  try {
    const out = execFileSync(NODE, [CLI, '--profile', 'web', '--dump-config'], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      // Capture stderr instead of letting a denied write dump a raw Node stack
      // over this report: the EPERM case below is a skip, not a crash.
      stdio: ['ignore', 'pipe', 'pipe'],
      // `--dump-config` resolves `$DSH_HOME/profiles`, and this CLI's default
      // home is `~/.dsh` — *not* the Desktop app's harness home. Omitting the
      // variable silently composes a freshly bootstrapped empty profile over
      // there, which then reports a missing mount line for a plugin that is
      // plainly mounted (and leaves a stray `~/.dsh` behind). Pass it through.
      env: { ...process.env, DSH_HOME },
    })
    const block = out.split('# == dsh-cad-preview')[1]?.split('# ==')[0] ?? ''
    record(
      block.includes('name: dsh-cad-preview'),
      '组合配置含挂载行',
      block.trim().split('\n').slice(0, 3).join(' | ') ||
        `dump 里没有 dsh-cad-preview 这一层；开头是：${out.trim().split('\n').slice(0, 2).join(' | ')}`,
    )
  } catch (error) {
    const text = String(error?.message ?? error)
    // `--dump-config` rewrites the profile's `cordis.yml` before printing.
    // Under a restricted file sandbox that write is denied (EPERM), which says
    // nothing about the plugin — report it as a skip, not a failure.
    if (/EPERM|EACCES|sandbox|operation not permitted/i.test(text)) {
      console.log('  skip  组合配置（当前环境不允许写 profile，跳过；这不是插件问题）')
    } else {
      record(false, '组合配置可解析', text.split('\n')[0])
    }
  }
} else {
  record(false, '找到 node/CLI', `缺 ${existsSync(NODE) ? CLI : NODE}`)
}

// ── 3. 运行中的 GUI ──────────────────────────────────────────────────────────
const explicitPort = argOf('--port', '')
const candidates = explicitPort === '' ? [43129, 43127, 3080, 3082] : [Number(explicitPort)]

const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    call.setTimeout(4000, () => call.destroy(new Error('timeout')))
    call.on('error', reject)
    call.end()
  })

let livePort = null
for (const port of candidates) {
  try {
    const response = await get(port, '/cad-preview/ping')
    if (response.status === 200 && response.body.toString('utf8').includes('dsh-cad-preview')) {
      livePort = port
      record(true, `运行中的 GUI 有响应 (127.0.0.1:${port})`, response.body.toString('utf8').trim())
      break
    }
    record(false, `127.0.0.1:${port} 未认出插件`, `HTTP ${response.status}`)
  } catch (error) {
    record(false, `127.0.0.1:${port} 连不上`, String(error?.message ?? error).split('\n')[0])
  }
}

// ── 4. 四条路线 ──────────────────────────────────────────────────────────────
if (livePort !== null) {
  const bundle = await get(livePort, '/cad-preview/client.js')
  record(bundle.status === 200 && bundle.body.length > 1_000_000, '浏览器 bundle 可达', `${bundle.status} · ${(bundle.body.length / 1048576).toFixed(2)} MB`)
  record(bundle.body.toString('utf8', 0, 400).includes('__ModuleLoader__'), 'bundle 带模块信封')

  const worker = await get(livePort, '/cad-preview/worker.js')
  const workerText = worker.body.toString('utf8')
  record(worker.status === 200 && workerText.includes('occtimportjs'), '解析 worker 可达且自带内核胶水', `HTTP ${worker.status} · ${(worker.body.length / 1024).toFixed(0)} KB`)
  record(workerText.includes('dsh-cad-preview/occt-worker@1'), 'worker 认协议标记')
  record(!/require\(["']occt-import-js["']\)/.test(workerText), 'worker 没有裸 require 内核')

  const wasm = await get(livePort, '/cad-preview/asset?name=occt-import-js.wasm', { range: 'bytes=0-63' })
  record(wasm.status === 206 && wasm.body.length === 64, 'CAD 内核可 Range 下载', `HTTP ${wasm.status} · ${wasm.headers['content-range'] ?? ''}`)

  const model = argOf('--model', join(PROFILE, 'node_modules', 'dsh-cad-preview', 'lib', 'client.js'))
  const served = await get(livePort, `/cad-preview/file?path=${encodeURIComponent(model)}`)
  record(served.status === 200, '模型字节路线可达', `${model.split('/').pop()} · HTTP ${served.status}`)
}

// ── 结论 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length} 通过, ${failed.length} 失败`)
if (failed.length === 0) {
  console.log('\n宿主侧完全正常。最后一步只能靠眼睛：在右侧栏文件树里点开一个 .step / .stl，')
  console.log('应当出现可旋转的 3D 模型；首次打开 STEP 会下载 7.6 MB 内核（之后走缓存）。')
} else {
  console.log('\n宿主侧有失败项。若只是"连不上"，通常是端口不对（用 --port 指定 GUI 地址栏里的端口），')
  console.log('或 GUI 还没起来。若"组合配置"失败，把输出发我。')
}
process.exit(failed.length === 0 ? 0 : 1)
