/**
 * Re-check the fitted clip planes across the whole zoom range.
 *
 * The invariant: at every distance the rig allows, the model's nearest surface
 * must be in front of `near`, and its farthest behind `far`. A `near` larger than
 * the camera-to-surface gap slices the model open.
 */
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

const path = '/Volumes/exSSD/DSH/image-production/cad-build/shouzhen-columns-skeleton/shouzhen-columns-skeleton.stl'
const bytes = readFileSync(path)
const geometry = new STLLoader().parse(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
)
geometry.computeBoundingSphere()
const radius = geometry.boundingSphere.radius
console.log(`包围球半径 ${radius.toFixed(0)}`)

const distances = [radius * 0.05, radius * 0.1, radius * 0.5, radius * 3.4, radius * 20, radius * 100]
let bad = 0
for (const distance of distances) {
  const near = Math.max(distance * 0.002, 1e-4)
  const far = distance + radius * 6
  // Worst case the camera is outside looking in; when it is inside the sphere the
  // nearest surface can be arbitrarily close, which `near` must respect.
  const frontOfModel = Math.max(distance - radius, distance * 0.05)
  const backOfModel = distance + radius
  const clipsNear = frontOfModel < near
  const clipsFar = backOfModel > far
  if (clipsNear || clipsFar) bad += 1
  console.log(
    `  距离 ${distance.toFixed(0).padStart(9)}  近 ${near.toFixed(2).padStart(8)}  远 ${far.toFixed(0).padStart(9)}` +
      `${clipsNear ? '   ← 近裁剪切模型' : ''}${clipsFar ? '   ← 远裁剪切模型' : ''}`,
  )
}
console.log(bad === 0 ? '\n全部缩放范围内都没有被裁剪 ✓' : `\n仍有 ${bad} 档会裁剪 ✗`)
geometry.dispose()
