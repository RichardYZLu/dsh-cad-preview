/**
 * Does the mesh contain coincident duplicate facets?
 *
 * Depth precision cannot separate two surfaces at *identical* depth, so a file
 * that stores the same triangle twice (or the same wall from two unioned solids)
 * will always shimmer — and no near/far tuning helps. This counts the duplicates
 * and the degenerate facets so the cause is known rather than guessed.
 */
import { readFileSync } from 'node:fs'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import * as THREE from 'three'

const MODELS = [
  ['柱网骨架', '/Volumes/exSSD/DSH/image-production/cad-build/shouzhen-columns-skeleton/shouzhen-columns-skeleton.stl'],
  ['佛龛样本', '/Volumes/exSSD/DSH/image-production/cad-build/fupen-samples/fupen-samples.stl'],
]

for (const [name, path] of MODELS) {
  const bytes = readFileSync(path)
  const geometry = new STLLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
  const position = geometry.getAttribute('position')
  const triangles = position.count / 3

  /** Quantised vertex key so float noise does not hide a true duplicate. */
  const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`

  const seen = new Set()
  let duplicates = 0
  let degenerate = 0
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i)
    b.fromBufferAttribute(position, i + 1)
    c.fromBufferAttribute(position, i + 2)
    // Zero-area facets render as nothing but still fight for depth.
    const area = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2
    if (area < 1e-9) degenerate += 1
    const corners = [key(a.x, a.y, a.z), key(b.x, b.y, b.z), key(c.x, c.y, c.z)].sort()
    const id = corners.join('|')
    if (seen.has(id)) duplicates += 1
    else seen.add(id)
  }

  // Winding vs stored normal: a mesh with mixed orientation shows hollow shells.
  const normal = geometry.getAttribute('normal')
  let inverted = 0
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const faceNormal = new THREE.Vector3()
  const stored = new THREE.Vector3()
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i)
    b.fromBufferAttribute(position, i + 1)
    c.fromBufferAttribute(position, i + 2)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    faceNormal.crossVectors(ab, ac)
    if (faceNormal.length() < 1e-9) continue
    faceNormal.normalize()
    stored.set(normal.getX(i), normal.getY(i), normal.getZ(i))
    if (stored.dot(faceNormal) < 0) inverted += 1
  }

  console.log(
    `${name}（${triangles.toLocaleString()} 面）\n` +
      `  完全重复的面 (含反向): ${duplicates.toLocaleString()} (${((duplicates / triangles) * 100).toFixed(2)}%)\n` +
      `  零面积/退化面:          ${degenerate.toLocaleString()}\n` +
      `  法向与绕序相反的三角面:  ${inverted.toLocaleString()} (${((inverted / triangles) * 100).toFixed(1)}%)`,
  )
  geometry.dispose()
}
