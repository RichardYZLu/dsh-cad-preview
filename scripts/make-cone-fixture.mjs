/**
 * Generate a calibration cone as both STEP and STL.
 *
 * The cone is the cleanest orientation check for a viewer: its base circle, its
 * axis and its apex each pin one degree of freedom, so a wrong up-axis or a
 * mis-placed ground plane is obvious at a glance.
 *
 *     base circle on z = 0 · base centre on the origin · apex up the +z axis
 *
 * STEP comes from FreeCAD's headless CLI (a real B-rep, the same shape a CAD
 * tool exports); STL is triangulated directly so a mesh comparison is possible
 * without any CAD dependency.
 *
 *   node scripts/make-cone-fixture.mjs [--radius 50] [--height 120] [--out <dir>]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}
const radius = Number(argOf('--radius', '50'))
const height = Number(argOf('--height', '120'))
const outDir = resolve(argOf('--out', join(root, 'test', 'fixtures')))
mkdirSync(outDir, { recursive: true })

const base = `cone-r${radius}-h${height}`

// ── STEP, via FreeCAD ────────────────────────────────────────────────────────
const freecad = '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd'
const scriptPath = join(outDir, `${base}.py`)
writeFileSync(
  scriptPath,
  [
    'import FreeCAD as App',
    'import Part',
    `cone = Part.makeCone(${radius}.0, 0.0, ${height}.0)  # base circle on z = 0`,
    'box = cone.BoundBox',
    'print("bbox", box.XMin, box.YMin, box.ZMin, box.XMax, box.YMax, box.ZMax)',
    'doc = App.newDocument("Cone")',
    'obj = doc.addObject("Part::Feature", "Cone")',
    'obj.Shape = cone',
    'doc.recompute()',
    `Part.export([obj], ${JSON.stringify(join(outDir, `${base}.step`))})`,
    '',
  ].join('\n'),
)
execFileSync(freecad, [scriptPath], { stdio: 'pipe' })
console.log(`STEP → ${join(outDir, `${base}.step`)}`)

// ── STL, triangulated here ───────────────────────────────────────────────────
const segments = 96
const facets = []
const triangles = []
const apex = [0, 0, height]

/**
 * Outward normal of a triangle, normalised.
 *
 * Written into the file rather than left as zeros: STL permits zero normals, but
 * a reader that takes them at face value shades every face black, and a fixture
 * that only renders correctly because the reader repaired it is a poor fixture.
 *
 * @param a - first vertex.
 * @param b - second vertex.
 * @param c - third vertex.
 * @returns the unit normal.
 */
function facetNormal([ax, ay, az], [bx, by, bz], [cx, cy, cz]) {
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const vx = cx - ax
  const vy = cy - ay
  const vz = cz - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const length = Math.hypot(nx, ny, nz) || 1
  return [nx / length, ny / length, nz / length]
}

for (let i = 0; i < segments; i += 1) {
  const a0 = (i / segments) * Math.PI * 2
  const a1 = ((i + 1) / segments) * Math.PI * 2
  const p0 = [radius * Math.cos(a0), radius * Math.sin(a0), 0]
  const p1 = [radius * Math.cos(a1), radius * Math.sin(a1), 0]
  triangles.push([p0, p1, apex])            // side
  triangles.push([[0, 0, 0], p1, p0])       // base, wound downward
  for (const [a, b, c] of [[p0, p1, apex], [[0, 0, 0], p1, p0]]) {
    const normal = facetNormal(a, b, c).map((value) => value.toFixed(6))
    facets.push(`facet normal ${normal.join(' ')}\n  outer loop`)
    facets.push(`    vertex ${a.join(' ')}\n    vertex ${b.join(' ')}\n    vertex ${c.join(' ')}`)
    facets.push('  endloop\nendfacet')
  }
}
const ascii = `solid ${base}\n${facets.join('\n')}\nendsolid ${base}\n`
writeFileSync(join(outDir, `${base}.stl`), ascii)
console.log(`STL  → ${join(outDir, `${base}.stl`)}  (${triangles.length} triangles)`)

// ── binary STL, same shape, for mesh-only viewers ────────────────────────────
const buffer = Buffer.alloc(84 + triangles.length * 50)
buffer.write(`dsh-cad-preview ${base}`, 0, 'ascii')
buffer.writeUInt32LE(triangles.length, 80)
let offset = 84
for (const triangle of triangles) {
  // The facet normal, explicitly — not skipped. See `facetNormal`.
  const normal = facetNormal(triangle[0], triangle[1], triangle[2])
  for (const value of normal) {
    buffer.writeFloatLE(value, offset)
    offset += 4
  }
  for (const vertex of triangle) {
    for (const value of vertex) {
      buffer.writeFloatLE(value, offset)
      offset += 4
    }
  }
  buffer.writeUInt16LE(0, offset)
  offset += 2
}
writeFileSync(join(outDir, `${base}.binary.stl`), buffer)
console.log(`STL  → ${join(outDir, `${base}.binary.stl`)}  (binary)`)
