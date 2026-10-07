/**
 * Confirm the sampler now builds pixel-width, opaque edges — the properties that
 * make line appearance independent of zoom.
 */
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

const bytes = readFileSync('/Volumes/exSSD/DSH/image-production/cad-build/fupen-samples/fupen-samples.stl')
const geometry = new STLLoader().parse(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
)
for (const threshold of [30, 1]) {
  const raw = new THREE.EdgesGeometry(geometry, threshold)
  const lines = new LineSegmentsGeometry()
  lines.setPositions(raw.getAttribute('position').array)
  const material = new LineMaterial({
    color: 0xdfe7f5,
    linewidth: 1.6,
    worldUnits: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  })
  const object = new LineSegments2(lines, material)
  console.log(
    `阈值 ${threshold}° → ${(raw.getAttribute('position').count / 2).toLocaleString()} 段\n` +
      `  worldUnits=${material.worldUnits}（false = 线宽以像素计）\n` +
      `  linewidth=${material.linewidth}px · 不透明=${!material.transparent} · 颜色 #${material.color.getHexString()}\n` +
      `  polygonOffset=${material.polygonOffset} factor=${material.polygonOffsetFactor} units=${material.polygonOffsetUnits}` +
      `（粗线是 instanced 四边形，所以此偏移真的生效）\n` +
      `  实例数=${lines.getAttribute('instanceStart').count.toLocaleString()} · 三角面=${(lines.getAttribute('instanceStart').count * 2).toLocaleString()}`,
  )
  void object
  raw.dispose()
}
geometry.dispose()
