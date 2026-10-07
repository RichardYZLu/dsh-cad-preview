/**
 * dsh-cad-preview — host half for the DSH web profile.
 *
 * Serves what the browser-side CAD viewer needs over four routes, all behind
 * the same browser trust fence the host's own `/api` documents (loopback Host
 * plus same-origin markers):
 *
 *   GET /cad-preview/file?path=<abs>   model bytes, HTTP Range capable
 *   GET /cad-preview/asset?name=<file> package-local assets (the OCCT wasm)
 *   GET /cad-preview/client.js         the prebuilt browser bundle
 *   GET /cad-preview/worker.js         the prebuilt parsing worker
 *
 * Why a dedicated route for the model bytes: the sidebar viewer needs the raw
 * bytes of a file the user opened in the explorer, and the explorer browses
 * absolute paths outside the session cwd. The route therefore accepts absolute
 * paths (like the official directory-picker browse backend and
 * dsh-media-preview) and streams with Range support, so a large STEP file is
 * never buffered whole on the host.
 *
 * The client half is `lib/client.js`, a single-file bundle that registers a
 * FileViewer with dsh-better-sidebar. Its OCCT wasm kernel is 7.6 MB, which is
 * far too large to inline into the bundle, so it is served from this route and
 * cached by the browser.
 *
 * `lib/client.worker.js` is the parsing worker: a classic script (no module
 * envelope — a worker has no `window.__ModuleLoader__`) that owns the wasm
 * kernel so tessellation never runs on the page's main thread. It is served
 * `no-cache`, like the bundle it belongs to, so an upgrade takes effect on the
 * next reload.
 */
import z from '@deepseek-ai/schemastery'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-cad-preview'

export const inject = ['webServer']

export const Config = z.object({
  /** Hard cap on one served model file. Defaults to 512 MiB. */
  maxModelBytes: z.number().step(1).min(1024).default(536870912),
  /** Extra non-loopback authorities accepted for these routes. */
  trustedHosts: z.array(z.string()).default([]),
})

const ROUTE_PREFIX = '/cad-preview'

/** All suffixes the browser viewer claims; the host only needs the MIME map. */
const CONTENT_TYPES = {
  '.step': 'application/step',
  '.stp': 'application/step',
  '.iges': 'model/iges',
  '.igs': 'model/iges',
  '.brep': 'application/octet-stream',
  '.stl': 'model/stl',
  '.3mf': 'model/3mf',
  '.obj': 'model/obj',
  '.ply': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Browser trust fence: loopback (or explicitly trusted) authority plus
 * same-origin markers, so a page on another origin cannot drive these routes.
 *
 * @param req - incoming request.
 * @param extraHosts - additional accepted authorities from config/runtime.
 * @returns whether the request may be served.
 */
function isTrustedRequest(req, extraHosts) {
  const host = String(req.headers.host ?? '').toLowerCase()
  if (host === '') return false
  const hostname = host.replace(/:\d+$/, '')
  const loopback = LOOPBACK_HOSTNAMES.has(hostname) || hostname.startsWith('127.')
  const trusted = extraHosts.some(
    (entry) => entry.toLowerCase() === host || entry.toLowerCase() === hostname,
  )
  if (!loopback && !trusted) return false
  const origin = String(req.headers.origin ?? '')
  if (origin !== '') {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return false
    } catch {
      return false
    }
  }
  if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return false
  return true
}

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
}

/**
 * Parse one `bytes=` request header.
 *
 * @param value - raw Range header ('' when absent).
 * @param size - total resource size in bytes.
 * @returns `null` for "no range, serve whole"; `'invalid'` for a syntactically
 * valid but unsatisfiable range; otherwise the resolved inclusive bounds.
 */
function parseRange(value, size) {
  if (value === '') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (match === null) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isInteger(suffix) || suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isInteger(start) || start < 0 || start > end || start >= size) return 'invalid'
  return { start, end }
}

/**
 * Stream one file with Range support.
 *
 * @param req - request carrying the optional Range header.
 * @param res - response to write.
 * @param absolutePath - file to serve.
 * @param extraHeaders - headers merged into both the 200 and 206 responses.
 */
function serveFile(req, res, absolutePath, extraHeaders) {
  let info
  try {
    info = statSync(absolutePath)
  } catch {
    return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
  }
  if (!info.isFile()) {
    return send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'not a regular file')
  }
  const size = info.size
  const common = {
    'content-type': CONTENT_TYPES[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    ...extraHeaders,
  }
  const range = parseRange(String(req.headers.range ?? ''), size)
  if (range === 'invalid') {
    return send(
      res,
      416,
      { 'content-type': 'text/plain; charset=utf-8', 'content-range': `bytes */${size}` },
      'range not satisfiable',
    )
  }
  if (range === null) {
    res.writeHead(200, { ...common, 'content-length': size })
  } else {
    res.writeHead(206, {
      ...common,
      'content-length': range.end - range.start + 1,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
    })
  }
  const stream = createReadStream(absolutePath, range === null ? undefined : range)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

export function apply(ctx, config) {
  /**
   * Accepted authorities, resolved per request.
   *
   * `webRuntime` is provided by the web-app bundle, which mounts *after* this
   * plugin in some profile orders — reading it once during `apply()` yields an
   * empty list, and the fence then rejects the loopback-less authorities a
   * tunnel or LAN URL uses (HTTP 403 "forbidden"). dsh-media-preview hit
   * exactly this and had to be configured by hand. Reading it at request time
   * costs nothing and removes the ordering dependency; `config.trustedHosts`
   * stays as the deterministic override.
   */
  const trustedHosts = () => {
    const collected = []
    // 1. the web runtime service, when it has mounted
    try {
      collected.push(...(ctx.get('webRuntime')?.trustedHosts ?? []))
    } catch {
      /* service absent or not ready */
    }
    // 2. the authorities this deployment already declares for its other routes:
    //    without this, an operator who configured the tunnel domain for
    //    /api and /sidebar would still have to repeat it here.
    try {
      for (const entry of ctx.loader?.entries?.() ?? []) {
        const name = entry?.options?.name
        if (name !== '@deepseek-ai/dsh-web-app' && name !== '@deepseek-ai/dsh-client-connection') continue
        collected.push(...(entry.options.config?.trustedHosts ?? []))
      }
    } catch {
      /* loader shape differs on older hosts */
    }
    return [...config.trustedHosts, ...collected]
  }
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const pluginVersion = (() => {
    try {
      return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version ?? '0.0.0'
    } catch {
      return '0.0.0'
    }
  })()

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (!isTrustedRequest(req, trustedHosts())) {
            // Name the rejected authority: this is the one failure a user hitting
            // the GUI through a tunnel or LAN URL runs into, and the fix (add it
            // to the plugin's `trustedHosts` in the profile patch) is not
            // guessable from a bare "forbidden".
            const host = String(req.headers.host ?? '(no Host header)')
            return send(
              res,
              403,
              { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
              `forbidden: ${host} is not a trusted authority for /cad-preview. ` +
                'Add it to this plugin\'s `trustedHosts` in the profile patch (see README).',
            )
          }
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            return send(res, 405, { 'content-type': 'text/plain; charset=utf-8' }, 'method not allowed')
          }

          if (url.pathname === `${ROUTE_PREFIX}/ping`) {
            return send(
              res,
              200,
              { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
              JSON.stringify({ ok: true, plugin: name, version: pluginVersion }),
            )
          }

          if (url.pathname === `${ROUTE_PREFIX}/client.js`) {
            return serveFile(req, res, join(packageRoot, 'lib', 'client.js'), {
              'cache-control': 'no-cache',
            })
          }

          if (url.pathname === `${ROUTE_PREFIX}/worker.js`) {
            return serveFile(req, res, join(packageRoot, 'lib', 'client.worker.js'), {
              'cache-control': 'no-cache',
            })
          }

          if (url.pathname === `${ROUTE_PREFIX}/asset`) {
            const asset = url.searchParams.get('name') ?? ''
            // No directory traversal: assets are single flat files in lib/.
            if (asset === '' || asset.includes('/') || asset.includes('\\') || asset.includes('..')) {
              return send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'invalid asset name')
            }
            if (!/\.wasm$/.test(asset)) {
              return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
            }
            return serveFile(req, res, join(packageRoot, 'lib', asset), {
              'cache-control': 'public, max-age=31536000, immutable',
            })
          }

          if (url.pathname !== `${ROUTE_PREFIX}/file`) {
            return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
          }

          const raw = url.searchParams.get('path')
          if (raw === null) {
            return send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'path is required')
          }
          // Absolute paths only: relative paths are ambiguous once the browser
          // is the client, and the caller (the explorer) always has the
          // resolved path. Whole-filesystem reach matches dsh-media-preview and
          // the official browse backend, both behind the same trust fence.
          if (!raw.startsWith('/')) {
            return send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'absolute path required')
          }
          let info
          try {
            info = await stat(raw)
          } catch {
            return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
          }
          if (!info.isFile() || info.size > config.maxModelBytes) {
            return send(
              res,
              400,
              { 'content-type': 'text/plain; charset=utf-8' },
              'not a file or too large',
            )
          }
          return serveFile(req, res, raw, { 'cache-control': 'no-cache' })
        },
      }),
    'dsh-cad-preview: model, asset, bundle and worker routes',
  )
}

export { parseRange, isTrustedRequest, CONTENT_TYPES }
