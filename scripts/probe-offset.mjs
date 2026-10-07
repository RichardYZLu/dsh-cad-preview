/**
 * What the polygon offset is actually worth, in world units.
 *
 * `polygonOffset` does not move geometry: it biases the depth value a fragment
 * writes, so it changes *who occludes whom* and nothing else — no position,
 * size, shading or colour. The bias is `factor × slope + units × r`, where `r` is
 * the smallest resolvable depth difference and the slope term grows for surfaces
 * seen edge-on. This converts that bias into millimetres so the setting can be
 * judged rather than guessed.
 *
 * Run: node scripts/probe-offset.mjs
 */
const BITS = 24
const quantum = 1 / (2 ** BITS - 1)

/** NDC depth for a view-space distance (positive, looking down -z). */
function depth(distance, near, far) {
  const ndc = (far + near) / (far - near) - (2 * far * near) / ((far - near) * distance)
  return ndc * 0.5 + 0.5
}

/**
 * World distance that changes the depth value by `target`.
 *
 * @param distance - view distance of the fragment.
 * @param near - near plane.
 * @param far - far plane.
 * @param target - depth change, in NDC depth units.
 * @returns the equivalent world-space distance.
 */
function worldEquivalent(distance, near, far, target) {
  const base = depth(distance, near, far)
  const direction = depth(distance + 1, near, far) < base ? 1 : -1
  let low = 0
  let high = distance
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2
    if (Math.abs(depth(distance + direction * mid, near, far) - base) < target) low = mid
    else high = mid
  }
  return low
}

// The sampler's clip-plane rule, at the reported building's scale.
const cases = [
  ['圆锥（半径 271，取景 271）', 271, 271],
  ['柱网骨架（半径 9257，取景 31475）', 9257, 31475],
]

console.log('面深度偏移 = factor 1 / units 1；线偏移 = factor -2 / units -4\n')
for (const [label, radius, distance] of cases) {
  const near = Math.max(distance * 0.002, 1e-4)
  const far = distance + radius * 6
  const r = worldEquivalent(distance, near, far, quantum)
  // A slope of 1 is a 45° surface; grazing faces have much larger slopes.
  for (const [name, slope] of [['正面朝向（斜率≈0）', 0], ['45° 斜面（斜率 1）', 1], ['掠射薄面（斜率 10）', 10]]) {
    const surfaceBias = worldEquivalent(distance, near, far, 1 * slope * quantum + 1 * quantum)
    const lineBias = worldEquivalent(distance, near, far, 2 * slope * quantum + 4 * quantum)
    console.log(
      `  ${label}\n    ${name}: 面被推后 ≈ ${surfaceBias.toFixed(3)} 世界单位` +
        ` · 线被前拉 ≈ ${lineBias.toFixed(3)} · 两者合计 ≈ ${(surfaceBias + lineBias).toFixed(3)}`,
    )
  }
  console.log(`    一个深度量化单位 ≈ ${r.toFixed(4)} 世界单位（距离 ${distance.toFixed(0)}，near ${near.toFixed(2)}，far ${far.toFixed(0)}）`)
}
