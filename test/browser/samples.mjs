/**
 * Serve the appearance sampler: four candidate looks on real CAD geometry.
 *
 * Kept entirely outside the plugin — this exists so a look can be chosen before
 * anything is built into the viewer. It serves the built sampler bundle, three,
 * and a small menu of real mesh exports.
 *
 *   node test/browser/samples.mjs [--port 8100]
 */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const argv = process.argv.slice(2)
const port = Number(argv[argv.indexOf('--port') + 1]) || 8100

// Real geometry, deliberately: a cube makes every variant look acceptable. The
// small one loads instantly; the larger ones show what density does to line work.
const MODELS = [
  { name: '构件几何（500 面）', path: '/Volumes/exSSD/DSH/image-production/cad-build/shouzhen-a-geometry/shouzhen-a-geometry.stl' },
  { name: '佛龛样本（7.2 万面）', path: '/Volumes/exSSD/DSH/image-production/cad-build/fupen-samples/fupen-samples.stl' },
  { name: '柱网骨架（稠密）', path: '/Volumes/exSSD/DSH/image-production/cad-build/shouzhen-columns-skeleton/shouzhen-columns-skeleton.stl' },
]

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
const send = (res, body, type) => res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body)

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, readFileSync(join(root, 'test', 'browser', 'samples.html')), types['.html'])
  }
  if (url.pathname === '/samples.js') {
    const source = readFileSync(join(root, 'lib', 'samples.js'), 'utf8')
      // One three instance only: addon imports are rewritten to the served copy.
      .replace(/from\s*"(?:three|\.\.\/build\/three\.module\.js)"/g, 'from "/three.module.js"')
      .replace(/from\s*"three\/examples\/jsm\//g, 'from "/addons/')
    return send(res, source, types['.js'])
  }
  if (url.pathname === '/three.module.js' || url.pathname === '/three.core.js') {
    const file = join(root, 'node_modules', 'three', 'build', basename(url.pathname))
    if (statSync(file, { throwIfNoEntry: false }) === undefined) return res.writeHead(404).end('missing')
    return send(res, readFileSync(file), types['.js'])
  }
  if (url.pathname.startsWith('/addons/')) {
    const relative = url.pathname.slice('/addons/'.length)
    const file = join(root, 'vendor', 'three', 'examples', 'jsm', relative)
    if (statSync(file, { throwIfNoEntry: false }) === undefined) {
      return res.writeHead(404).end(`missing addon ${relative}`)
    }
    const source = readFileSync(file, 'utf8')
      // Addons import three through several relative spellings; normalise them
      // all so the page shares the bundle's single instance instead of loading a
      // second copy (which silently breaks materials and renderers).
      .replace(/from\s*(['"])[^'"]*three(?:\.module)?\.js\1/g, "from '/three.module.js'")
      .replace(/from\s*(['"])three\1/g, "from '/three.module.js'")
    return send(res, source, types['.js'])
  }
  if (url.pathname === '/models') {
    const menu = MODELS.filter((model) => statSync(model.path, { throwIfNoEntry: false }) !== undefined)
      .map((model) => ({ name: model.name, url: `/model/${encodeURIComponent(basename(model.path))}`, bytes: statSync(model.path).size }))
    return send(res, JSON.stringify(menu), 'application/json')
  }
  if (url.pathname.startsWith('/model/')) {
    const wanted = decodeURIComponent(url.pathname.slice('/model/'.length))
    const model = MODELS.find((candidate) => basename(candidate.path) === wanted)
    if (model === undefined) return res.writeHead(404).end('unknown model')
    return send(res, readFileSync(model.path), 'model/stl')
  }
  return res.writeHead(404).end('not found')
})

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
console.log(`可读性方案小样: http://127.0.0.1:${port}/`)
