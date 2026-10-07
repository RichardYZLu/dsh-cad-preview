import { build } from 'esbuild'
import { join } from 'node:path'

const root = process.cwd()
await build({
  entryPoints: [join(root, 'src', 'samples', 'appearance.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(root, 'lib', 'samples.js'),
  // three and its addons stay external: the sampler server rewrites them to the
  // served copies, so the page runs one three instance (two copies would produce
  // "material belongs to a different renderer" style failures).
  external: ['three', 'three/examples/jsm/*'],
  logLevel: 'silent',
})
console.log('samples.js 构建完成')
