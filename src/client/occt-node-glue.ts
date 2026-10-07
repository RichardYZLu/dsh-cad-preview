/**
 * The kernel loader for the headless test build.
 *
 * Identical to the browser's (`occt-glue.ts`) except that the wasm comes from
 * `test/fixtures` — Node has no host route to fetch it from — and the glue's
 * Node-only `require`s are served for real, so the same glue text runs under
 * both runtimes.
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GLUE_SOURCE, makeLoader } from './occt-glue'

const fixtureDir = process.env.CAD_PREVIEW_FIXTURES
  ? resolve(process.env.CAD_PREVIEW_FIXTURES)
  : resolve('test', 'fixtures')

const nodeRequire = createRequire(import.meta.url)

export { GLUE_SOURCE, makeLoader }

/**
 * The disk read lives in `node-entry.ts`, which installs it as the byte loader;
 * this factory only supplies the glue and its Node-side `require` scope.
 *
 * @returns the glue factory, to be called as `factory({ wasmBinary })`.
 */
export default function loadOcctFactory() {
  return makeLoader(GLUE_SOURCE, {
    require: (id) => nodeRequire(id),
    dirname: fileURLToPath(new URL('.', import.meta.url)),
  })
}

/** Fixture path used by `node-entry.ts`; exported so the test can report it. */
export const fixtureDirectory = fixtureDir
