/**
 * Copy the OCCT wasm kernel and its licence notices into the package.
 *
 * The kernel is a 7.6 MB binary that cannot live inside client.js, so it ships
 * beside it in `lib/` and is served by the host route
 * (`GET /cad-preview/asset?name=occt-import-js.wasm`). A second copy under
 * `test/fixtures` lets the headless parser test load the same binary.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'node_modules', 'occt-import-js', 'dist')

const targets = [
  join(root, 'lib', 'occt-import-js.wasm'),
  join(root, 'test', 'fixtures', 'occt-import-js.wasm'),
]

if (!existsSync(join(source, 'occt-import-js.wasm'))) {
  console.error('[sync-assets] occt-import-js is not installed; run pnpm install first')
  process.exit(1)
}

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(source, 'occt-import-js.wasm'), target)
  console.log(`[sync-assets] ${target}`)
}

// Licences travel with the binary: OpenCascade is LGPL-2.1 and occt-import-js
// is MIT. Both notices ship in the published package AND under test/fixtures
// (the headless test loads the wasm from there).
const notices = [
  '# Third-party notices — dsh-cad-preview',
  '',
  '`lib/occt-import-js.wasm` is the OpenCascade-based import kernel from',
  '[occt-import-js](https://github.com/kovacsv/occt-import-js) v0.0.23 (MIT).',
  'It links OpenCascade Technology (LGPL-2.1 with the OCCT exception); the',
  'corresponding licence texts are reproduced below verbatim.',
  '',
  '---',
  '',
  readFileSync(join(source, 'license.occt-import-js.txt'), 'utf8').trim(),
  '',
  '---',
  '',
  readFileSync(join(source, 'license.occt.txt'), 'utf8').trim(),
  '',
]

writeFileSync(join(root, 'lib', 'THIRD-PARTY-NOTICES.md'), notices.join('\n'))
writeFileSync(join(root, 'test', 'fixtures', 'THIRD-PARTY-NOTICES.md'), notices.join('\n'))
console.log('[sync-assets] THIRD-PARTY-NOTICES.md written')
