/**
 * Download the B-rep fixtures (STEP / IGES / BREP).
 *
 * They are the small cube samples from occt-import-js's own test suite, pinned
 * to the exact package version this plugin links. Run once; the files are then
 * committed/kept beside the test so a bare checkout needs no network.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.0.23'
const BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${VERSION}/test/testfiles`
const dir = fileURLToPath(new URL('.', import.meta.url))

const files = [
  { url: `${BASE}/cube-10x10mm/Cube%2010x10.stp`, target: 'cube.step' },
  { url: `${BASE}/cube-10x10mm/Cube%2010x10.igs`, target: 'cube.igs' },
  { url: `${BASE}/cax-if-brep/as1_pe_203.brep`, target: 'cube.brep' },
]

mkdirSync(dir, { recursive: true })
for (const { url, target } of files) {
  const response = await fetch(url)
  if (!response.ok) {
    console.error(`[fetch-fixtures] ${target}: HTTP ${response.status} from ${url}`)
    process.exitCode = 1
    continue
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(join(dir, target), bytes)
  console.log(`[fetch-fixtures] ${target} ${(bytes.length / 1024).toFixed(1)} KB`)
}
