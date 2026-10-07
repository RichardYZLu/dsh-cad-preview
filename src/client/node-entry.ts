/**
 * Headless entry point for `test/smoke.mjs`.
 *
 * Same viewer source as the browser build; only the kernel byte source differs
 * — a disk read from `test/fixtures`, installed through the same seam the
 * browser uses for its fetch. That keeps one byte-loading contract in
 * `viewer.tsx` for both runtimes.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as client from './viewer'

const fixtureDir = process.env.CAD_PREVIEW_FIXTURES
  ? resolve(process.env.CAD_PREVIEW_FIXTURES)
  : resolve('test', 'fixtures')

client.setWasmLoader(
  async () => new Uint8Array(await readFile(join(fixtureDir, 'occt-import-js.wasm'))),
)

export const name = 'dsh-cad-preview'
export const apply = client.apply
export const __test = client.__test
