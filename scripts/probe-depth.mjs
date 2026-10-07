/**
 * Depth-buffer precision at the distance the viewer actually uses.
 *
 * A near/far ratio of 10^7 (0.01 .. 100000) is the classic z-fighting recipe:
 * the reverse-Z mapping spends almost all its resolution near the camera, so two
 * surfaces a millimetre apart z-fight at model scale. This prints the smallest
 * separable distance at the model, for the current planes and for fitted ones.
 */
const near0 = 0.01
const far0 = 100000

/** Distance at which two depths a delta apart become indistinguishable. */
function separationAt(distance, near, far, bits = 24) {
  const n = near
  const f = far
  const z = (d) => {
    // OpenGL-style projection depth, then quantise to `bits`.
    const ndc = (f + n) / (f - n) - (2 * f * n) / ((f - n) * d)
    const depth = ndc * 0.5 + 0.5
    return Math.round(depth * (2 ** bits - 1)) / (2 ** bits - 1)
  }
  const step = 1 / (2 ** bits - 1)
  let delta = distance * 1e-9
  let previous = z(distance)
  for (let i = 0; i < 200; i += 1) {
    const next = z(distance + delta)
    if (next > previous) return delta
    delta *= 1.5
  }
  return delta
}

const cases = [
  ['圆锥（半径 271mm 取景距离）', 271],
  ['真实建筑（半径 33209mm 取景距离）', 33209],
]

for (const [label, distance] of cases) {
  const current = separationAt(distance, near0, far0)
  // Planes fitted to the model: near just inside the front, far just outside.
  const extent = distance / 3.4
  const fitted = separationAt(distance, extent * 0.05, extent * 40)
  console.log(
    `${label}\n` +
      `  当前 0.01/100000 : 可分辨的最小间距 ≈ ${current.toExponential(2)} mm` +
      `\n  自适应 ${(extent * 0.05).toFixed(2)}/${(extent * 40).toFixed(0)}   : 可分辨的最小间距 ≈ ${fitted.toExponential(2)} mm` +
      `\n  改善倍数 ≈ ${(current / fitted).toFixed(0)}×`,
  )
}
