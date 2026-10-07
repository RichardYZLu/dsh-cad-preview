/**
 * Serve the browser self-check page for the scene wiring.
 *
 * The grid's orientation is the one thing that kept disagreeing between my
 * measurements and the reporter's screen, and neither a headless WebGL stub nor
 * a geometry dump settles it. This serves the *built* scene module to a real
 * browser, renders it, and prints the grid's measured world pose on the page —
 * so the answer comes from the same environment the sidebar uses.
 *
 *   node test/browser/serve.mjs [--port 8099]
 */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const argv = process.argv.slice(2)
const port = Number(argv[argv.indexOf('--port') + 1]) || 8099

const pluginHost = await import(new URL('../../lib/index.js', import.meta.url).href)
let pluginHandler
pluginHost.apply(
  {
    effect: (fn) => fn(),
    get: () => undefined,
    webServer: {
      register(registration) {
        pluginHandler = registration.handler
        return () => {}
      },
    },
  },
  { maxModelBytes: 512 * 1024 * 1024, trustedHosts: [] },
)

const serve = (res, body, type) => {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body)
}
const notFound = (res) => res.writeHead(404).end('not found')

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/cad-preview')) return pluginHandler(req, res)
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serve(res, readFileSync(join(root, 'test', 'browser', 'page.html')), 'text/html; charset=utf-8')
  }
  if (url.pathname === '/scene.js') {
    // The scene module, with the bare `three` specifier rewritten to the served
    // copy: bare specifiers do not resolve without an import map.
    const source = readFileSync(join(root, 'lib', 'scene-browser.js'), 'utf8')
      .replace(/from\s*"three"/g, "from '/three.module.js'")
    return serve(res, source, 'text/javascript; charset=utf-8')
  }
  // `three`'s exports map hides ./build/**, so these are addressed by path. The
  // browser entry imports its sibling three.core.js with a relative specifier,
  // and a module that 404s fails the whole graph *without* reaching the page's
  // try/catch — which is exactly how this page first loaded as a blank screen.
  if (url.pathname === '/three.module.js' || url.pathname === '/three.core.js') {
    const file = join(root, 'node_modules', 'three', 'build', url.pathname.slice(1))
    if (statSync(file, { throwIfNoEntry: false }) === undefined) {
      return serve(res, `missing ${url.pathname}`, 'text/plain; charset=utf-8')
    }
    return serve(res, readFileSync(file), 'text/javascript; charset=utf-8')
  }
  return notFound(res)
})

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
console.log(`browser self-check: http://127.0.0.1:${port}/   （菜单：加 ?bare=1 只看网格）`)
