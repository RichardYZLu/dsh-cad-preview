/**
 * Generate a heavy B-rep fixture for the stability stress run.
 *
 * Why a grid of small spheres, of all shapes:
 *
 *   - The reader tessellates with `linearDeflectionType: 'bounding_box_ratio'`
 *     (see `occt-kernel.ts`), so the triangle count follows the *ratio* of
 *     curvature detail to the model's bounding box. Spreading a few large parts
 *     out therefore makes each part *cheaper* — 20 cones across 5.7 m came back
 *     as 419 triangles each, against 1391 for the single cone.
 *   - Many small spheres in a compact grid does the opposite: a 2.28 MB STEP
 *     with 4913 spheres tessellates to 4,264,484 triangles (~868 per sphere).
 *     That is the shape a stability test wants: a small file, an enormous mesh,
 *     and no multi-megabyte fixture to keep in the project.
 *
 * Presets (measured on this machine, OpenCascade 7.8 via occt-import-js 0.0.23):
 *
 *   a  12³ = 1728 spheres  → 1,499,904 triangles   0.79 MB   4.1 s in the worker
 *   b  17³ = 4913 spheres  → 4,264,484 triangles   2.28 MB  11.1 s in the worker
 *
 * Usage:
 *   node scripts/make-stress-fixtures.mjs [--preset a|b] [--grid 12]
 *                                        [--radius 2] [--spacing 5] [--out <dir>]
 *
 * Then:
 *   pnpm stress --model test/fixtures/stress/stress-a-1728spheres.step
 *   pnpm stress --preset b
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

const PRESETS = {
  a: { grid: 12, radius: 2, spacing: 5 },
  b: { grid: 17, radius: 2, spacing: 5 },
}
const preset = argOf('--preset', '')
if (preset !== '' && PRESETS[preset] === undefined) {
  console.error(`unknown preset "${preset}" (known: ${Object.keys(PRESETS).join(', ')})`)
  process.exit(2)
}
const chosen = preset === '' ? { grid: 12, radius: 2, spacing: 5 } : PRESETS[preset]
const grid = Number(argOf('--grid', String(chosen.grid)))
const radius = Number(argOf('--radius', String(chosen.radius)))
const spacing = Number(argOf('--spacing', String(chosen.spacing)))
const outDir = resolve(argOf('--out', join(root, 'test', 'fixtures', 'stress')))
mkdirSync(outDir, { recursive: true })

const freecad = '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd'
if (!existsSync(freecad)) {
  console.error(
    `FreeCAD's headless CLI is required to build a real B-rep fixture.\n` +
      `Expected at ${freecad}. Without it, run the stress suite against the\n` +
      `shipped cone instead: pnpm stress`,
  )
  process.exit(2)
}

const solids = grid ** 3
const base = `stress-${preset === '' ? `g${grid}` : preset}-${solids}spheres`
const out = join(outDir, `${base}.step`)
const scriptPath = join(outDir, `${base}.py`)

// FreeCAD needs a real document to export; a compound of every sphere keeps the
// file to a single product, which is what a CAD tool would hand a viewer too.
writeFileSync(
  scriptPath,
  [
    'import FreeCAD as App, Part',
    'shapes = []',
    `for i in range(${grid}):`,
    `    for j in range(${grid}):`,
    `        for k in range(${grid}):`,
    `            s = Part.makeSphere(${radius}.0)`,
    `            s.translate(App.Vector(i * ${spacing}.0, j * ${spacing}.0, k * ${spacing}.0))`,
    '            shapes.append(s)',
    'compound = Part.makeCompound(shapes)',
    `doc = App.newDocument("Stress")`,
    'obj = doc.addObject("Part::Feature", "Stress")',
    'obj.Shape = compound',
    'doc.recompute()',
    `Part.export([obj], ${JSON.stringify(out)})`,
    `print("exported", ${solids}, "spheres")`,
    '',
  ].join('\n'),
)

console.log(`[stress-fixtures] FreeCAD is building ${solids} spheres (grid ${grid}³, r=${radius}, spacing ${spacing})…`)
// PYTHONDONTWRITEBYTECODE: FreeCAD imports the generated script, which would
// otherwise leave a __pycache__ directory inside the fixtures.
execFileSync(freecad, [scriptPath], {
  stdio: 'pipe',
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
})
// FreeCAD's bundled Python writes bytecode regardless of the env var above, so
// the cache is removed explicitly rather than left in the fixtures.
rmSync(join(outDir, '__pycache__'), { recursive: true, force: true })
console.log(`[stress-fixtures] STEP → ${out}`)
console.log(`[stress-fixtures] generator script kept at ${scriptPath}`)
console.log('[stress-fixtures] expected scale: ~868 triangles per sphere at this ratio')
console.log(`[stress-fixtures] run: pnpm stress --model ${out}`)
