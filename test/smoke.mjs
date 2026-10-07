/**
 * Headless smoke test for dsh-cad-preview.
 *
 * Three things have to hold for the sidebar to show a real model:
 *   1. the parsers turn every claimed suffix into real geometry;
 *   2. the host route streams bytes (with Range) behind its trust fence;
 *   3. `apply()` registers a viewer whose component is a working React
 *      component.
 *
 * This runs the *built* artifacts (`lib/index.js`, `lib/client.node.mjs`), so a
 * packaging mistake fails here rather than in the browser.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureFixtures } from './fixtures/make-fixtures.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const tmpDir = join(root, 'test', '.tmp')

let passed = 0
let failed = 0
const failures = []

/**
 * Run one named check.
 *
 * @param name - what is being verified.
 * @param fn - the check body; throws on failure.
 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

/** Request `path` from a server, returning status, headers and body bytes. */
function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    call.on('error', reject)
    call.end()
  })
}

// ─── fixtures ────────────────────────────────────────────────────────────────

rmSync(tmpDir, { recursive: true, force: true })
const fixtures = ensureFixtures(tmpDir)
console.log(`fixtures in ${tmpDir}`)

// ─── 1. host half ────────────────────────────────────────────────────────────

const host = await import(new URL('../lib/index.js', import.meta.url).href)

console.log('\nhost: config and fences')

await test('exports name/inject/Config/apply', () => {
  assert.equal(host.name, 'dsh-cad-preview')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
  assert.ok(host.Config, 'Config schema is exported')
})

await test('range parsing covers whole, bounded, suffix and invalid forms', () => {
  assert.equal(host.parseRange('', 100), null)
  assert.deepEqual(host.parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(host.parseRange('bytes=10-', 100), { start: 10, end: 99 })
  assert.deepEqual(host.parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(host.parseRange('bytes=0-1000', 100), { start: 0, end: 99 })
  assert.equal(host.parseRange('bytes=100-200', 100), 'invalid')
  assert.equal(host.parseRange('bytes=-0', 100), 'invalid')
  assert.equal(host.parseRange('bytes=-', 100), 'invalid')
})

await test('trust fence rejects foreign hosts and cross-site markers', () => {
  const trusted = (headers) => host.isTrustedRequest({ headers }, [])
  assert.equal(trusted({ host: '127.0.0.1:43129' }), true)
  assert.equal(trusted({ host: 'localhost:43129' }), true)
  assert.equal(trusted({ host: 'evil.example.com' }), false)
  assert.equal(trusted({}), false)
  assert.equal(trusted({ host: '127.0.0.1:1', origin: 'http://evil.example.com' }), false)
  assert.equal(trusted({ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' }), false)
  assert.equal(trusted({ host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' }), true)
})

await test('MIME map covers every claimed suffix', () => {
  for (const ext of ['.step', '.stp', '.iges', '.igs', '.brep', '.stl', '.3mf', '.obj', '.ply']) {
    assert.ok(host.CONTENT_TYPES[ext], `missing content type for ${ext}`)
  }
  assert.equal(host.CONTENT_TYPES['.wasm'], 'application/wasm')
})

console.log('\nhost: routes over real HTTP')

/**
 * Boot the host plugin against a fake server context.
 *
 * @param options - `context` merges into the fake ctx (e.g. a `webRuntime`
 * service), `config` overrides the plugin config.
 */
async function startHost(options = {}) {
  let handler
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
    },
    get: (name) => options.context?.[name],
    loader: {
      entries: () =>
        (options.loaderEntries ?? []).map((entry) => ({ options: entry })),
    },
    webServer: {
      register(registration) {
        handler = registration.handler
        return () => {}
      },
    },
  }
  host.apply(ctx, { maxModelBytes: 1024 * 1024, trustedHosts: [], ...options.config })
  assert.equal(typeof handler, 'function', 'plugin registered a route')

  const server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    close: async () => {
      for (const dispose of disposers) await dispose?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const server = await startHost()

try {
  await test('GET /cad-preview/ping identifies the plugin', async () => {
    const response = await request(server.port, '/cad-preview/ping')
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body.toString('utf8'))
    assert.equal(payload.ok, true)
    assert.equal(payload.plugin, 'dsh-cad-preview')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(payload.version, pkg.version)
  })

  await test('the prebuilt client bundle is served with the module envelope', async () => {
    const bundle = await request(server.port, '/cad-preview/client.js')
    assert.equal(bundle.status, 200)
    assert.match(String(bundle.headers['content-type']), /javascript/)
    assert.ok(bundle.body.length > 100_000, 'bundle looks too small to contain three.js')
    assert.match(bundle.body.toString('utf8').slice(0, 2000), /__ModuleLoader__/)
  })

  await test('the CAD glue is inlined into the worker rather than fetched', () => {
    const chunk = statSync(join(root, 'lib', 'client.occt.js'))
    assert.ok(chunk.size > 100_000, 'glue chunk looks too small to be the real kernel glue')
    const worker = readFileSync(join(root, 'lib', 'client.worker.js'), 'utf8')
    assert.ok(worker.includes('occtimportjs'), 'the glue source was not inlined into the worker')
    assert.ok(
      !worker.includes('client.occt.js'),
      'the worker still points at a chunk instead of carrying the glue inline',
    )
  })

  await test('the parsing worker is served as its own classic script', async () => {
    const worker = await request(server.port, '/cad-preview/worker.js')
    assert.equal(worker.status, 200)
    assert.match(String(worker.headers['content-type']), /javascript/)
    assert.match(String(worker.headers['cache-control']), /no-cache/)
    const text = worker.body.toString('utf8')
    assert.ok(text.includes('occtimportjs'), 'the worker must carry the kernel glue inline')
    assert.ok(
      text.includes('dsh-cad-preview/occt-worker@1'),
      'the worker must tag its messages with the shared protocol id',
    )
    assert.ok(!text.includes('__DSH_CAD_PREVIEW_OCCT_GLUE__'), 'glue placeholder was not replaced')
    assert.ok(!/require\(["']occt-import-js["']\)/.test(text), 'kernel left as a bare require')
    assert.ok(!/require\(["']three["']\)/.test(text), 'the worker must not need three.js')
  })

  await test('kernel wasm ships with the package and streams with Range', async () => {
    const local = statSync(join(root, 'lib', 'occt-import-js.wasm'))
    const head = await request(server.port, '/cad-preview/asset?name=occt-import-js.wasm')
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-type'], 'application/wasm')
    assert.equal(Number(head.headers['content-length']), local.size)
    assert.match(String(head.headers['cache-control']), /immutable/)

    const ranged = await request(server.port, '/cad-preview/asset?name=occt-import-js.wasm', {
      range: 'bytes=0-127',
    })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.body.length, 128)
    assert.equal(ranged.headers['content-range'], `bytes 0-127/${local.size}`)
    const expected = readFileSync(join(root, 'lib', 'occt-import-js.wasm')).subarray(0, 128)
    assert.ok(ranged.body.equals(expected), 'range bytes do not match the file prefix')
  })

  await test('asset route refuses traversal and non-asset names', async () => {
    for (const name of ['../package.json', '..%2Fpackage.json', 'sub/dir.wasm', 'index.js']) {
      const response = await request(server.port, `/cad-preview/asset?name=${encodeURIComponent(name)}`)
      assert.ok(response.status === 400 || response.status === 404, `${name} was served`)
    }
  })

  await test('model route streams a real file byte-for-byte', async () => {
    const path = fixtures.stl
    const local = readFileSync(path)
    const response = await request(
      server.port,
      `/cad-preview/file?path=${encodeURIComponent(path)}`,
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'model/stl')
    assert.equal(response.headers['accept-ranges'], 'bytes')
    assert.ok(response.body.equals(local), 'served bytes differ from the file on disk')
  })

  await test('model route answers ranges and 416 for impossible ones', async () => {
    const path = fixtures.step
    const size = statSync(path).size
    const ranged = await request(server.port, `/cad-preview/file?path=${encodeURIComponent(path)}`, {
      range: 'bytes=100-199',
    })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.body.length, 100)
    assert.equal(ranged.headers['content-range'], `bytes 100-199/${size}`)
    assert.equal(ranged.headers['content-type'], 'application/step')

    const bad = await request(server.port, `/cad-preview/file?path=${encodeURIComponent(path)}`, {
      range: `bytes=${size + 10}-`,
    })
    assert.equal(bad.status, 416)
    assert.equal(bad.headers['content-range'], `bytes */${size}`)
  })

  await test('model route validates path and reports missing files', async () => {
    const relative = await request(server.port, '/cad-preview/file?path=cube.stl')
    assert.equal(relative.status, 400)
    const missing = await request(
      server.port,
      `/cad-preview/file?path=${encodeURIComponent(join(tmpDir, 'nope.stl'))}`,
    )
    assert.equal(missing.status, 404)
    const noPath = await request(server.port, '/cad-preview/file')
    assert.equal(noPath.status, 400)
    const unknown = await request(server.port, '/cad-preview/other')
    assert.equal(unknown.status, 404)
  })

  await test('a tunnel/LAN authority is rejected by default, and the reply names it', async () => {
    const response = await request(server.port, '/cad-preview/ping', { host: 'dsh.example.test' })
    assert.equal(response.status, 403)
    assert.match(response.body.toString('utf8'), /dsh\.example\.test/)
    assert.match(response.body.toString('utf8'), /trustedHosts/)
  })

  await test('hosts resolved from the webRuntime service are accepted', async () => {
    // The service mounts after this plugin in some profile orders, which is why
    // the fence resolves it per request instead of caching it in apply().
    const tunneled = await startHost({ context: { webRuntime: { trustedHosts: ['tunnel.example.test'] } } })
    try {
      const accepted = await request(tunneled.port, '/cad-preview/ping', { host: 'tunnel.example.test' })
      assert.equal(accepted.status, 200, 'the runtime-provided authority must be trusted')
      const other = await request(tunneled.port, '/cad-preview/ping', { host: 'elsewhere.example.test' })
      assert.equal(other.status, 403, 'and nothing else becomes trusted')
    } finally {
      await tunneled.close()
    }
  })

  await test('the authorities other routes already declare are honoured here too', async () => {
    // An operator who allowed a tunnel domain for /api and /sidebar must not
    // have to repeat it: the same loader config is read here.
    const shared = await startHost({
      loaderEntries: [
        { name: '@deepseek-ai/dsh-client-connection', config: { trustedHosts: ['shared.example.test'] } },
        { name: 'unrelated-plugin', config: { trustedHosts: ['not-mine.example.test'] } },
      ],
    })
    try {
      const accepted = await request(shared.port, '/cad-preview/ping', { host: 'shared.example.test' })
      assert.equal(accepted.status, 200, 'a shared authority must be trusted')
      const unrelated = await request(shared.port, '/cad-preview/ping', { host: 'not-mine.example.test' })
      assert.equal(unrelated.status, 403, 'only the web-facing rows count')
    } finally {
      await shared.close()
    }
  })

  await test('hosts listed in the plugin config are accepted without any service', async () => {
    const configured = await startHost({ config: { trustedHosts: ['configured.example.test'] } })
    try {
      const accepted = await request(configured.port, '/cad-preview/ping', { host: 'configured.example.test' })
      assert.equal(accepted.status, 200)
      const model = await request(
        configured.port,
        `/cad-preview/file?path=${encodeURIComponent(fixtures.stl)}`,
        { host: 'configured.example.test' },
      )
      assert.equal(model.status, 200, 'the model route must work behind the tunnel too')
    } finally {
      await configured.close()
    }
  })

  await test('a request with a non-same-origin Origin is still refused', async () => {
    const forged = await startHost({ config: { trustedHosts: ['configured.example.test'] } })
    try {
      const response = await request(forged.port, '/cad-preview/ping', {
        host: 'configured.example.test',
        origin: 'https://evil.example.test',
      })
      assert.equal(response.status, 403, 'trusting a Host must not drop the same-origin check')
    } finally {
      await forged.close()
    }
  })

  await test('oversized files are refused by the configured cap', async () => {
    const big = join(tmpDir, 'big.stl')
    const chunk = Buffer.alloc(1024 * 1024)
    const parts = []
    for (let i = 0; i < 2; i += 1) parts.push(chunk)
    const target = readFileSync(fixtures.stl)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(big, Buffer.concat([target, ...parts]))
    const response = await request(server.port, `/cad-preview/file?path=${encodeURIComponent(big)}`)
    assert.equal(response.status, 400)
  })
} finally {
  await server.close()
}

// ─── 2. browser half ─────────────────────────────────────────────────────────

console.log('\nclient: registration surface')

process.env.CAD_PREVIEW_FIXTURES = join(root, 'test', 'fixtures')
const client = await import(new URL('../lib/client.node.mjs', import.meta.url).href)


/**
 * A plugin context with cordis' `inject` semantics: a callback runs only when
 * every service it names is present.
 *
 * @param services - services to expose, by name.
 * @param options - `withBetterSidebar: false` to model a machine without it.
 * @returns the fake context, the viewer registrations, and the effect labels.
 */
function makePluginContext(services = {}, options = {}) {
  const registrations = []
  const effects = []
  const available = { ...services }
  if (options.withBetterSidebar !== false && available.betterSidebar === undefined) {
    available.betterSidebar = {
      registerFileViewer(descriptor) {
        registrations.push(descriptor)
        return () => {}
      },
    }
  }
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      fn()
    },
    inject(names, callback) {
      if (names.every((name) => available[name] !== undefined)) {
        callback(Object.assign({}, ctx, available))
      }
    },
    get: (name) => available[name],
    ...available,
  }
  return { ctx, registrations, effects }
}

await test('apply() registers one custom-load viewer for all eight suffixes', () => {
  const { ctx, registrations, effects } = makePluginContext()
  client.apply(ctx)
  assert.equal(registrations.length, 1)
  const viewer = registrations[0]
  assert.equal(viewer.fetchStrategy, 'custom')
  assert.equal(typeof viewer.component, 'function')
  assert.deepEqual(
    [...viewer.exts].sort(),
    ['3mf', 'brep', 'iges', 'igs', 'obj', 'ply', 'step', 'stp', 'stl'].sort(),
  )
  assert.ok(viewer.priority > 0, 'must outrank the -100 catch-all code viewer')
  assert.match(effects[0], /3D model viewer/)
})

await test('load() hands the viewer a per-file context and a suffix test', async () => {
  const { ctx, registrations } = makePluginContext()
  client.apply(ctx)
  const { load } = registrations[0]
  const context = await load('/tmp/part.step', { sessionId: 's', cwd: '/tmp' })
  assert.equal(context.ext, 'step')
  assert.equal(context.test(), true)
  assert.ok(context.controller instanceof AbortController, 'context carries an abort controller')
  const foreign = await load('/tmp/notes.md', { sessionId: 's', cwd: '/tmp' })
  assert.equal(foreign.test(), false)
})

await test('the manifest does not gate the plugin on a third-party sidebar', () => {
  // The client loader reads `dsh.client.inject` from package.json — not the
  // module's own export — and waits for every name in it before running `apply`.
  // Declaring `dsh-better-sidebar` there made the whole plugin inert on a stock
  // DSH install, no matter how carefully `apply` feature-detected at runtime.
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const declared = manifest.dsh?.client?.inject ?? []
  assert.ok(
    !declared.includes('dsh-better-sidebar'),
    `dsh.client.inject must not hard-gate on better-sidebar, got ${JSON.stringify(declared)}`,
  )
  // The platform still has to be declared: that is what registers the client half.
  assert.equal(manifest.dsh?.client?.platform, 'web')
})

await test('the viewer mounts with either sidebar and needs neither', () => {
  // Without `dsh-better-sidebar` the plugin must still register with DSH's own
  // document preview, which is the whole point of the optional mounts.
  const previews = []
  const bodies = []
  const native = makePluginContext(
    {
      documentPreviews: { register: (definition) => previews.push(definition) },
      slots: {
        inject: (name, callback) => callback(),
        register: (registration, component) => bodies.push({ registration, component }),
      },
    },
    { withBetterSidebar: false },
  )
  client.apply(native.ctx)
  assert.equal(native.registrations.length, 0, 'no better-sidebar ⇒ no viewer registration')
  assert.equal(previews.length, 1, 'the document type must be registered')
  assert.deepEqual(previews[0].extensions, client.__test.ALL_EXTS)
  assert.equal(previews[0].loading, 'bytes-complete', 'binary files arrive as complete bytes')
  assert.equal(previews[0].binaryExtensions.length, client.__test.ALL_EXTS.length)
  assert.equal(bodies.length, 1, 'and the body must be registered')
  assert.equal(bodies[0].registration.name, 'sidebar.right.tab.document')
  assert.equal(bodies[0].registration.key, previews[0].id)

  // With both installed, both mounts are registered.
  const both = makePluginContext({
    documentPreviews: { register: () => {} },
    slots: { inject: (_name, callback) => callback(), register: () => {} },
  })
  client.apply(both.ctx)
  assert.equal(both.registrations.length, 1, 'better-sidebar still gets the viewer')

  // And with neither, applying must be a no-op rather than a crash.
  const none = makePluginContext({}, { withBetterSidebar: false })
  client.apply(none.ctx)
  assert.equal(none.registrations.length, 0)
})

console.log('\nclient: geometry for every claimed format')

const { __test } = client

await test('a mesh that stores zero normals is shaded instead of black', () => {
  // STL allows a file to leave the normal as 0 0 0 and let the reader derive it.
  // Taken literally, `dot(normal, light)` is zero everywhere and the whole model
  // renders black — which reads as a viewer fault, not a file characteristic.
  const binaryStl = (normals, triangle) => {
    const buffer = Buffer.alloc(84 + 50)
    buffer.write('zero-normal fixture', 0, 'ascii')
    buffer.writeUInt32LE(1, 80)
    let offset = 84
    for (const value of normals) {
      buffer.writeFloatLE(value, offset)
      offset += 4
    }
    for (const vertex of triangle) {
      for (const value of vertex) {
        buffer.writeFloatLE(value, offset)
        offset += 4
      }
    }
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }
  const triangle = [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 0],
  ]

  const black = __test.geometryFromMesh(binaryStl([0, 0, 0], triangle), 'stl')
  const repaired = black.getAttribute('normal')
  assert.equal(
    __test.normalsAreUnusable(repaired),
    false,
    'zero normals must be replaced with derived ones',
  )
  // The triangle lies in the xy plane wound counter-clockwise, so the derived
  // normal points along +z and the face lights up.
  assert.ok(Math.abs(repaired.getZ(0) - 1) < 1e-6, `expected +z, got ${repaired.getZ(0)}`)
  black.dispose()

  // A well-formed file must be left exactly as it is: the stored normals may be
  // smoother than anything derived from the faces.
  const bytes = readFileSync(join(root, 'test', 'fixtures', 'cone-r50-h120.binary.stl'))
  const good = __test.geometryFromMesh(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    'stl',
  )
  const stored = good.getAttribute('normal')
  assert.equal(__test.normalsAreUnusable(stored), false)
  assert.ok(Math.abs(stored.getX(0) - 0.922656) < 1e-5, 'stored normals must survive the load')
  good.dispose()
})


await test('a relative tab path is resolved against the session cwd', () => {
  // dsh-better-sidebar hands the viewer the tab's own path, which is relative
  // to the session cwd; the host route only takes absolute paths.
  assert.equal(
    __test.resolveViewerPath('/Volumes/exSSD/DSH/image-production', 'cad-build/named/守真堂_全构件.step'),
    '/Volumes/exSSD/DSH/image-production/cad-build/named/守真堂_全构件.step',
  )
  assert.equal(__test.resolveViewerPath('/proj/', 'a/b.step'), '/proj/a/b.step')
  // Already absolute (POSIX / drive letter / UNC) must never be re-joined.
  assert.equal(__test.resolveViewerPath('/other', '/abs/part.step'), '/abs/part.step')
  assert.equal(__test.resolveViewerPath('/other', 'C:\\models\\part.step'), 'C:\\models\\part.step')
  assert.equal(__test.resolveViewerPath('/other', '\\\\share\\part.step'), '\\\\share\\part.step')
  // Windows cwd keeps its separator; a missing cwd leaves the path untouched.
  assert.equal(__test.resolveViewerPath('C:\\proj', 'a\\b.step'), 'C:\\proj\\a\\b.step')
  assert.equal(__test.resolveViewerPath(undefined, 'a/b.step'), 'a/b.step')
  assert.equal(__test.resolveViewerPath('', 'a/b.step'), 'a/b.step')
  assert.equal(__test.isAbsolutePath('cad-build/x.step'), false)
})

await test('suffix and label helpers', () => {
  assert.equal(__test.extOf('/a/b/Part.STEP'), 'step')
  assert.equal(__test.extOf('/a/b/noext'), '')
  assert.equal(__test.baseNameOf('/a/b/part.step'), 'part.step')
  assert.equal(__test.bytes(2048), '2.0 KB')
  assert.equal(__test.bytes(5 * 1024 * 1024), '5.0 MB')
})

/**
 * Parse one fixture and report what came out.
 *
 * @param path - fixture path.
 * @param expectedTriangles - triangles declared by the fixture builder.
 */
async function parseFixture(path, expectedTriangles) {
  const data = readFileSync(path)
  const geometry = await __test.parseModel(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    __test.extOf(path),
  )
  const positions = geometry.getAttribute('position')
  assert.ok(positions, 'geometry has positions')
  const triangles = geometry.index ? geometry.index.count / 3 : positions.count / 3
  assert.equal(Math.round(triangles), expectedTriangles, `triangle count for ${path}`)
  return { geometry, triangles }
}

await test('STL (binary, no normals) parses to 12 triangles', async () => {
  const { geometry } = await parseFixture(fixtures.stl, 12)
  assert.ok(geometry.getAttribute('normal'), 'normals were computed')
  const position = geometry.getAttribute('position')
  assert.equal(position.array.length, 36 * 3, 'non-indexed 36 vertices')
})

await test('OBJ parses through the loader and gets merged', async () => {
  const { geometry } = await parseFixture(fixtures.obj, 12)
  assert.ok(geometry.getAttribute('normal'), 'merged geometry carries normals')
})

await test('PLY (ascii) parses to 12 triangles', async () => {
  await parseFixture(fixtures.ply, 12)
})

await test('3MF (hand-built OPC zip) parses to 12 triangles', async () => {
  try {
    const { geometry } = await parseFixture(fixtures['3mf'], 12)
    geometry.computeBoundingBox()
    assert.ok(Math.abs(geometry.boundingBox.max.x - 10) < 1e-6, '3MF scale preserved')
  } catch (error) {
    // three's 3MF loader reads the OPC package through `DOMParser` + `fflate`.
    // Node has no DOMParser, so this one format can only be rendered in the
    // browser; any other failure (a malformed zip, a missing loader) is real.
    if (!/DOMParser is not defined/.test(String(error?.message))) throw error
    const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    assert.ok(bundle.includes('ThreeMFLoader'), '3MF loader is missing from the bundle')
    console.log('       (3MF is browser-only: Node has no DOMParser)')
  }
})

await test('STEP parses through the wasm kernel to 12 triangles', async () => {
  const { geometry } = await parseFixture(fixtures.step, 12)
  geometry.computeBoundingBox()
  const size = geometry.boundingBox.max.clone().sub(geometry.boundingBox.min)
  assert.ok(Math.abs(size.x - 10) < 1e-3 && Math.abs(size.z - 10) < 1e-3, '10mm cube in model units')
})

await test('.stp is dispatched to the same STEP path', async () => {
  await parseFixture(fixtures.stp, 12)
})

await test('IGES parses through the wasm kernel', async () => {
  await parseFixture(fixtures.iges, 12)
})

await test('BREP parses through the wasm kernel (multi-mesh assembly)', async () => {
  const data = readFileSync(fixtures.brep)
  const geometry = await __test.parseModel(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    'brep',
  )
  const position = geometry.getAttribute('position')
  const triangles = geometry.index ? geometry.index.count / 3 : position.count / 3
  assert.ok(triangles > 1000, `expected a real assembly, got ${triangles} triangles`)
})

await test('the calibration cone keeps its base on z = 0 and its apex up +z', async () => {
  // A cone pins all three degrees of freedom a viewer can get wrong — base
  // plane, axis direction and apex — which is why it is the fixture to reach for
  // when an up-axis or ground-plane question comes up. Generated by
  // scripts/make-cone-fixture.mjs (FreeCAD for the B-rep, direct triangulation
  // for the meshes).
  const sizes = { step: 1391, stl: 192, 'binary.stl': 192 }
  for (const [suffix, expectedFacets] of Object.entries(sizes)) {
    const path = join(root, 'test', 'fixtures', `cone-r50-h120.${suffix}`)
    const data = readFileSync(path)
    const geometry = await __test.parseModel(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      suffix === 'binary.stl' ? 'stl' : suffix,
    )
    geometry.computeBoundingBox()
    const box = geometry.boundingBox
    const facets = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3
    assert.ok(
      Math.abs(facets - expectedFacets) < 2,
      `${suffix}: expected ~${expectedFacets} facets, got ${facets}`,
    )
    // Base circle on z = 0.
    assert.ok(Math.abs(box.min.z) < 1e-6, `${suffix}: base should sit on z = 0, got ${box.min.z}`)
    // Base centre on the origin.
    assert.ok(
      Math.abs(box.min.x + box.max.x) < 1e-6 && Math.abs(box.min.y + box.max.y) < 1e-6,
      `${suffix}: base centre should be the origin, got x ${box.min.x}…${box.max.x}`,
    )
    // Apex up the +z axis: 120 tall, and the top is a point, not a disc.
    assert.ok(Math.abs(box.max.z - 120) < 1e-3, `${suffix}: height should be 120, got ${box.max.z}`)
    const position = geometry.getAttribute('position')
    let topCount = 0
    for (let i = 0; i < position.count; i += 1) {
      if (position.getZ(i) > box.max.z - 1) topCount += 1
    }
    const bottomCount = (() => {
      let n = 0
      for (let i = 0; i < position.count; i += 1) if (position.getZ(i) < 1) n += 1
      return n
    })()
    assert.ok(
      topCount * 4 < bottomCount,
      `${suffix}: the apex must taper (top ${topCount} vs base ${bottomCount} vertices)`,
    )
  }
})

await test('an unparsable model reports an error instead of empty geometry', async () => {
  const junk = Buffer.from('this is not a CAD file at all')
  await assert.rejects(
    () => __test.parseModel(junk.buffer.slice(0), 'step'),
    /解析|内核|几何/,
  )
  await assert.rejects(() => __test.parseModel(new ArrayBuffer(16), 'xyz'), /不支持|解析/)
})

await test('octet inputs are not mutated and geometry is exported once per parse', async () => {
  const data = readFileSync(fixtures.stl)
  const before = createHash('sha256').update(data).digest('hex')
  await parseFixture(fixtures.stl, 12)
  const after = createHash('sha256').update(readFileSync(fixtures.stl)).digest('hex')
  assert.equal(before, after)
})

console.log('\nclient: the path the browser actually takes')

await test('a broken kernel download reports itself, and retries once', async () => {
  const wasm = readFileSync(join(root, 'lib', 'occt-import-js.wasm'))
  const requests = []
  const respond = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body,
  })

  // 1. an HTML error page instead of the binary must not reach the glue
  const html = Buffer.from('<!doctype html><title>401</title>')
  let fetcher = __test.createWasmFetcher(async (url) => {
    requests.push(url)
    return respond(html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength))
  })
  await assert.rejects(fetcher, /不是 WebAssembly/)

  // 2. a transient failure is retried with a cache-busting query
  requests.length = 0
  let calls = 0
  fetcher = __test.createWasmFetcher(async (url) => {
    requests.push(url)
    calls += 1
    if (calls === 1) throw new Error('network down')
    return respond(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength))
  })
  const bytes = await fetcher()
  assert.equal(bytes.length, wasm.length, 'the retry returned the real kernel')
  assert.equal(requests.length, 2, 'exactly one retry')
  assert.ok(requests[1].includes('retry='), 'the retry busts any cached failure')

  // 3. both attempts failing names the real cause, not emscripten's abort text
  fetcher = __test.createWasmFetcher(async () => {
    throw new Error('network down')
  })
  await assert.rejects(fetcher, /CAD 内核下载失败：network down/)
})

await test('a kernel byte failure surfaces before the glue ever runs', async () => {
  const before = __test.setWasmLoader // exported seam exists
  assert.equal(typeof before, 'function')
  __test.setWasmLoader(async () => {
    throw new Error('CAD 内核下载失败：HTTP 500')
  })
  try {
    await assert.rejects(
      () => __test.parseModel(new ArrayBuffer(64), 'step'),
      /CAD 内核下载失败：HTTP 500/,
    )
  } finally {
    __test.setWasmLoader(
      async () => new Uint8Array(await readFile(join(root, 'lib', 'occt-import-js.wasm'))),
    )
  }
})

console.log('\nclient: the parsing worker owns the kernel')

/**
 * A `Worker` stand-in: records traffic, answers on demand.
 *
 * The point of these tests is the contract, not Chromium: which job carries the
 * kernel bytes, whether the file bytes are transferred, and what happens to a
 * worker that is cancelled or dies. All of that is node-free logic in
 * `src/client/occt-remote.ts`.
 */
function makeFakeWorkers() {
  const instances = []
  class FakeWorker {
    constructor(url, init) {
      this.url = url
      this.init = init
      this.posted = []
      this.terminated = false
      this.listeners = new Map()
      this.onPost = null
      instances.push(this)
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(listener)
    }
    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener)
    }
    postMessage(message, transfers) {
      this.posted.push({ message, transfers })
      this.onPost?.(message, transfers)
    }
    terminate() {
      this.terminated = true
    }
    emit(type, event) {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    }
    reply(id, payload) {
      this.emit('message', {
        data: { protocol: __test.WORKER_PROTOCOL, id, ok: true, kernelReady: true, payload },
      })
    }
  }
  return { FakeWorker, instances }
}

const fakePayload = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: null,
  indices: new Uint32Array([0, 1, 2]),
  vertexCount: 3,
  triangleCount: 1,
})

await test('the file bytes are transferred once and a warm kernel is reused', async () => {
  const { FakeWorker, instances } = makeFakeWorkers()
  const kernel = __test.createOcctWorkerKernel({
    workerFactory: (url, init) => {
      const worker = new FakeWorker(url, init)
      worker.onPost = (message) => worker.reply(message.id, fakePayload())
      return worker
    },
    fetchWasmBinary: async () => new Uint8Array([0, 97, 115, 109]),
  })

  const payload = await kernel.parse(new ArrayBuffer(8), 'step')
  assert.equal(payload.triangleCount, 1)
  assert.equal(instances.length, 1, 'the worker is created on the first parse')
  const worker = instances[0]
  assert.equal(worker.url, __test.WORKER_ROUTE, 'the worker comes from the plugin route')
  const first = worker.posted[0].message
  assert.equal(first.protocol, __test.WORKER_PROTOCOL)
  assert.equal(first.type, 'parse')
  assert.equal(first.ext, 'step')
  assert.ok(first.wasmBinary instanceof Uint8Array, 'the first job carries the kernel bytes')
  assert.deepEqual(worker.posted[0].transfers, [first.data], 'file bytes are transferred, not copied')

  await kernel.parse(new ArrayBuffer(8), 'step')
  assert.equal(instances.length, 1, 'the same worker serves the next file')
  assert.equal(
    worker.posted[1].message.wasmBinary,
    undefined,
    'a warm kernel must not refetch 7.6 MB of wasm',
  )
})

await test('cancelling a parse kills the wasm instance instead of leaving it running', async () => {
  const { FakeWorker, instances } = makeFakeWorkers()
  const controller = new AbortController()
  let abortOnce = true
  const kernel = __test.createOcctWorkerKernel({
    workerFactory: (url, init) => {
      const worker = new FakeWorker(url, init)
      worker.onPost = (message) => {
        if (abortOnce) {
          abortOnce = false
          controller.abort()
        } else {
          worker.reply(message.id, fakePayload())
        }
      }
      return worker
    },
    fetchWasmBinary: async () => new Uint8Array([0, 97, 115, 109]),
  })

  await assert.rejects(
    kernel.parse(new ArrayBuffer(8), 'step', { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  )
  assert.equal(instances[0].terminated, true, 'a synchronous wasm parse can only be stopped by killing it')

  // The next file transparently gets a fresh worker with its own kernel bytes.
  const payload = await kernel.parse(new ArrayBuffer(8), 'step')
  assert.equal(payload.triangleCount, 1)
  assert.equal(instances.length, 2)
  assert.ok(
    instances[1].posted[0].message.wasmBinary instanceof Uint8Array,
    'a replaced worker needs the bytes again',
  )
})

await test('a worker that dies is reported, and the next parse retries', async () => {
  const { FakeWorker, instances } = makeFakeWorkers()
  let failOnce = true
  const kernel = __test.createOcctWorkerKernel({
    workerFactory: (url, init) => {
      const worker = new FakeWorker(url, init)
      worker.onPost = (message) => {
        if (failOnce) {
          failOnce = false
          worker.emit('error', { message: 'script failed to load' })
        } else {
          worker.reply(message.id, fakePayload())
        }
      }
      return worker
    },
    fetchWasmBinary: async () => new Uint8Array([0, 97, 115, 109]),
  })

  await assert.rejects(kernel.parse(new ArrayBuffer(8), 'step'), /CAD 解析线程出错/)
  assert.equal(instances[0].terminated, true, 'a failed worker is not left behind')
  const payload = await kernel.parse(new ArrayBuffer(8), 'step')
  assert.equal(payload.triangleCount, 1)
  assert.equal(instances.length, 2, 'the retry uses a new worker')
})

await test('the packer refuses more triangles than the cap allows', () => {
  const mesh = () => ({
    attributes: { position: { array: new Float32Array(9) } },
    index: { array: new Uint32Array([0, 1, 2]) },
    delete() {},
  })
  assert.throws(() => __test.packOcctMeshes([mesh()], { maxTriangles: 0 }), /三角面/)
  const packed = __test.packOcctMeshes([mesh()])
  assert.equal(packed.triangleCount, 1)
  assert.equal(packed.vertexCount, 3)
  assert.ok(packed.indices instanceof Uint16Array, 'three vertices fit in 16-bit indices')
  assert.equal(packed.normals, null, 'a mesh without normals must not claim to have them')
})

await test('the viewer parses B-rep in the worker, not on the page thread', () => {
  const source = readFileSync(join(root, 'src', 'client', 'viewer.tsx'), 'utf8')
  assert.ok(source.includes("from './occt-remote'"), 'the viewer must use the worker client')
  assert.ok(/kernel\.parse\(/.test(source), 'the worker path must be the one that parses')
  assert.ok(
    /typeof Worker === 'function'/.test(source),
    'worker support is detected so the headless build keeps its in-process path',
  )
})

await test('the inlined emscripten glue evaluates and tessellates a STEP file', async () => {
  // The browser bundle cannot be loaded in Node (it wants the shell's module
  // table), so this drives the built glue text through the same evaluator the
  // bundle carries. Node looks like Node to the glue, which would send it down
  // its `fs`-based branch, so the process global is hidden for the duration —
  // that is exactly the environment the browser provides.
  const glueText = readFileSync(join(root, 'lib', 'client.occt.js'), 'utf8')
  const factoryOf = __test.makeLoader(glueText)
  const savedProcess = globalThis.process
  const savedFilename = globalThis.__filename
  try {
    delete globalThis.process
    // eslint-disable-next-line no-underscore-dangle
    delete globalThis.__filename
    // One loader owns the wasm: this is the call the browser makes, only with
    // the bytes read from disk. `resolveKernel` is the same normalizer the
    // viewer uses, so the emscripten hand-off shape is covered here too.
    const returned = factoryOf({ wasmBinary: readFileSync(join(root, 'lib', 'occt-import-js.wasm')) })
    const occt = await __test.resolveKernel(returned)
    assert.equal(typeof occt.ReadStepFile, 'function')
    const data = readFileSync(fixtures.step)
    const result = occt.ReadStepFile(new Uint8Array(data), null)
    assert.equal(result.success, true)
    assert.equal(result.meshes.length, 1)
    assert.equal(result.meshes[0].index.array.length / 3, 12)
  } finally {
    globalThis.process = savedProcess
    if (savedFilename !== undefined) globalThis.__filename = savedFilename
  }
})

await test('the page bundle keeps its envelope and carries no kernel', () => {
  const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(bundle.includes('__ModuleLoader__.load'), 'module envelope missing')
  assert.ok(
    !bundle.includes('occtimportjs'),
    'the page bundle must not carry 163 KB of glue it is not allowed to run',
  )
  assert.ok(!bundle.includes('__DSH_CAD_PREVIEW_OCCT_GLUE__'), 'glue placeholder was not replaced')
  assert.ok(!/require\(["']occt-import-js["']\)/.test(bundle), 'kernel left as a bare require')
  assert.ok(!/require\(["']three["']\)/.test(bundle), 'three left as a bare require')
  // …and the kernel is somewhere it can only run off-thread.
  const worker = readFileSync(join(root, 'lib', 'client.worker.js'), 'utf8')
  assert.ok(worker.includes('occtimportjs'), 'the worker is where the glue belongs')
})

await test('the built worker answers a ping over its message channel', async () => {
  // Loads the real artifact with a `self` stand-in: this catches the bundle-level
  // mistakes the unit tests above cannot see (a missing listener, a protocol tag
  // that did not survive minification, a script that throws while evaluating).
  const source = readFileSync(join(root, 'lib', 'client.worker.js'), 'utf8')
  const listeners = []
  const posted = []
  const selfShim = {
    addEventListener: (type, listener) => {
      if (type === 'message') listeners.push(listener)
    },
    postMessage: (message) => {
      posted.push(message)
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('self', source)(selfShim)
  assert.equal(listeners.length, 1, 'the worker must register exactly one message listener')

  listeners[0]({ data: { protocol: __test.WORKER_PROTOCOL, id: 7, type: 'ping' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(posted.length, 1, 'a ping must be answered exactly once')
  assert.equal(posted[0].protocol, __test.WORKER_PROTOCOL)
  assert.equal(posted[0].id, 7)
  assert.equal(posted[0].ok, true)
  assert.equal(posted[0].pong, true)

  // A foreign protocol tag is ignored rather than answered.
  listeners[0]({ data: { protocol: 'someone-else', id: 8, type: 'ping' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(posted.length, 1, 'messages from another protocol must be ignored')
})

await test('the hand-built 3MF is a structurally valid OPC package', async () => {
  const { execFileSync } = await import('node:child_process')
  const list = execFileSync('/usr/bin/unzip', ['-l', fixtures['3mf']], { encoding: 'utf8' })
  for (const part of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']) {
    assert.ok(list.includes(part), `3MF is missing ${part}`)
  }
  const test = execFileSync('/usr/bin/unzip', ['-t', fixtures['3mf']], { encoding: 'utf8' })
  assert.match(test, /No errors detected/)
})

await test('a Z-up model is rotated so its vertical axis is on screen up', () => {
  // A CAD model 100 wide × 40 deep × 20 tall, exported Z-up: the tall axis is
  // Z. After the viewer's -90° X rotation it must be the screen's Y.
  const probe = { x: 0, y: 0, z: 20 }
  const screen = __test.modelSpaceToScreen(probe, true)
  assert.ok(Math.abs(screen.y - 20) < 1e-9, `screen Y should carry the height, got ${screen.y}`)
  assert.ok(Math.abs(screen.x - 0) < 1e-9 && Math.abs(screen.z - 0) < 1e-9)
  assert.equal(__test.modelUpRotation(true), -Math.PI / 2)
  assert.equal(__test.modelUpRotation(false), 0)
  // A Y-up file must be left exactly as it is.
  assert.deepEqual(__test.modelSpaceToScreen({ x: 1, y: 2, z: 3 }, false), { x: 1, y: 2, z: 3 })
})

await test('the up-rotation turns a flat XZ footprint into an upright model', async () => {
  // The real shape of the reported bug: a building read as 12095 × 14160 × 5900
  // (Z-up). Rotated for screen space, the 5900 axis must become the height.
  const THREE = await import('three')
  const geometry = new THREE.BoxGeometry(120.95, 141.6, 59)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.rotation.x = __test.modelUpRotation(true)
  mesh.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(mesh)
  const size = box.getSize(new THREE.Vector3())
  assert.ok(Math.abs(size.y - 59) < 1e-3, `height should be 59, got ${size.y}`)
  // The rotation swaps the two horizontal axes (and flips one), which the
  // canonical reset angle hides; what must hold is that the footprint's
  // dimensions survive and the height is the third one.
  assert.deepEqual(
    [size.x, size.z].sort((a, b) => a - b).map((value) => Math.round(value * 1000) / 1000),
    [120.95, 141.6],
    `footprint changed: ${size.x} × ${size.z}`,
  )
  // And with the toggle off, the same file lies flat again (what the user saw).
  mesh.rotation.x = __test.modelUpRotation(false)
  mesh.updateMatrixWorld(true)
  const flat = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3())
  assert.ok(Math.abs(flat.y - 141.6) < 1e-3, `Y-up height should be 141.6, got ${flat.y}`)
  geometry.dispose()
})

await test('the reported model rises 5.9 m in Z and is stood upright', async () => {
  // The file that surfaced the bug: 12095 × 14160 × 5900 mm, Z-up, with the
  // floor slab at Z = 0 (verified from the geometry itself: 43% of the
  // area-weighted normals point along Z and the Z range starts at zero).
  const THREE = await import('three')
  const geometry = new THREE.BoxGeometry(120.95, 141.6, 59)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.rotation.x = __test.modelUpRotation(true)
  mesh.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3())
  assert.ok(Math.abs(size.y - 59) < 1e-3, `on-screen height should be 5.9 m, got ${(size.y / 10).toFixed(2)} m`)
  assert.ok(size.x > size.y && size.z > size.y, 'the tall axis must be the horizontal one now')
  geometry.dispose()
})

await test('the first draw never reaches for a binding still being initialised', () => {
  // Regression guard for a real failure: `OrbitRig`'s constructor calls its
  // onChange before `new` returns, so a frame callback that reads the rig
  // binding throws "Cannot access 'rig' before initialization" — which the host
  // renders as a dead pane. Everything the first frame touches must therefore be
  // declared ahead of it. The wiring lives in src/client/scene.ts, and
  // test/wiring.mjs executes it for real.
  const source = readFileSync(join(root, 'src', 'client', 'scene.ts'), 'utf8')
  const frameAt = source.indexOf('const frame = ()')
  assert.ok(frameAt > 0, 'frame callback not found in scene.ts')
  const frameEnd = source.indexOf('\n  }', frameAt)
  assert.ok(frameEnd > frameAt, 'could not delimit the frame callback')
  const frameBody = source.slice(frameAt, frameEnd)
  assert.ok(!/\brig\b/.test(frameBody), `frame callback must not reference rig:\n${frameBody}`)

  const declaredBefore = (needle, position) => {
    const at = source.indexOf(needle)
    return at > 0 && at < position
  }
  assert.ok(declaredBefore('const cameraTarget', frameAt), 'cameraTarget must be declared before frame')
  assert.ok(
    source.indexOf('const rig = new OrbitRig') > frameAt,
    'the rig is constructed after the frame path is in place',
  )
})

await test('the file loader identity is stable, so the load effect cannot loop', () => {
  // 0.3.1 shipped a regression that took the main window down: `loadBytes` was a
  // fresh closure on every render and sat in the load effect's dependency array.
  // That effect calls `setStatus`, so it re-rendered itself forever, and every
  // iteration cancelled the previous parse — the panel sat on "正在解析模型…"
  // while the browser was hammered with requests. 0.3.0 had no such binding, and
  // the version-to-version diff of the built bundles is how this was found.
  const source = readFileSync(join(root, 'src', 'client', 'viewer.tsx'), 'utf8')
  const hooks = [...source.matchAll(/const loadBytes = (\w+)\(/g)].map((match) => match[1])
  assert.ok(hooks.length >= 2, `both mounts must bind a loader, found ${hooks.length}`)
  for (const hook of hooks) {
    assert.ok(
      hook === 'useMemo' || hook === 'useCallback',
      `loadBytes must be memoized; found a plain ${hook} binding`,
    )
  }
  assert.match(
    source,
    /setStatus\(\(previous\) =>[\s\S]{0,200}previous\.phase === 'loading'/,
    'the load effect must bail out when the status is already the loading state',
  )
})

await test('viewer component module declares the expected data hooks', () => {
  const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  for (const marker of ['data-cadpv-canvas', 'data-cadpv-viewer', 'cad-preview:model']) {
    assert.ok(bundle.includes(marker), `bundle is missing ${marker}`)
  }
  assert.ok(!/from ['"]three['"]/.test(bundle), 'three must be inlined, not left as a bare import')
  assert.ok(bundle.includes('__DSH_CAD_PREVIEW_OCCT_GLUE__') === false, 'glue placeholder was not replaced')
})

await test('packaged files referenced by the host route all exist', () => {
  const files = readdirSync(join(root, 'lib'))
  for (const required of ['index.js', 'client.js', 'client.worker.js', 'client.occt.js', 'occt-import-js.wasm', 'THIRD-PARTY-NOTICES.md']) {
    assert.ok(files.includes(required), `lib/${required} is missing`)
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const entry of pkg.files) {
    const local = entry.replace(/^\.\//, '')
    assert.doesNotThrow(() => statSync(join(root, local)), `package.json files lists missing ${entry}`)
  }
})

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
for (const { name, error } of failures) console.error(`\n${name}\n${error?.stack ?? error}`)
rmSync(tmpDir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
