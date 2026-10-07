/**
 * `pnpm pack` as an older version, for reproducing a previously installed
 * dependency.
 *
 * A profile's package.json pins the exact tarball path it was installed from,
 * so replacing a version means the old tarball must still exist while pnpm
 * re-resolves the graph. This packs such a file from the current tree by
 * temporarily rewriting the version (build output is version-independent, and
 * the result is only ever used to satisfy that one resolution).
 *
 *   node scripts/pack-version.mjs 0.1.0 [0.1.1 …]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagePath = join(root, 'package.json')
const original = readFileSync(packagePath, 'utf8')
const manifest = JSON.parse(original)

const versions = process.argv.slice(2)
if (versions.length === 0) {
  console.error('usage: node scripts/pack-version.mjs <version> [version …]')
  process.exit(1)
}

try {
  for (const version of versions) {
    writeFileSync(packagePath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
    const output = execFileSync('pnpm', ['pack', '--pack-destination', 'dist'], {
      cwd: root,
      encoding: 'utf8',
    })
    console.log(output.trim().split('\n').pop())
  }
} finally {
  writeFileSync(packagePath, original)
}
