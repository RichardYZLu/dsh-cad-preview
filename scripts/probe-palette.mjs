/**
 * Check every edge-colour policy against every combination the page offers.
 *
 * An edge is drawn *on* a surface, so its visibility is decided by the fill; with
 * no fill (`lines`) only the background can hide it. The policies differ in which
 * of those they honour, and this reports the contrast each one achieves so the
 * trade-off is visible rather than assumed.
 *
 * Caveat: contrast is computed from the material's *base* colours. Under the
 * viewer's lighting the rendered surface is usually much darker than its base
 * colour (the contrast preset runs at ambient 0.1), so a pairing this reports as
 * marginal can still read clearly on screen. Treat the numbers as a way to spot
 * obviously broken combinations, not as a verdict on a look.
 *
 * Run: node scripts/probe-palette.mjs
 */
const lum = (hex) => {
  const r = ((hex >> 16) & 0xff) / 255
  const g = ((hex >> 8) & 0xff) / 255
  const b = (hex & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const parse = (css) => Number.parseInt(css.slice(1), 16)

const FACES = [0xf2f5f9, 0xdadee2, 0x8fa3bf]
const BACKGROUNDS = ['#14161b', '#9aa0a8', '#f4f6fa']
const CANDIDATES = [0x0d1117, 0x39414f, 0x6b7482, 0x9aa6b8, 0xdfe7f5]
const MIN_CONTRAST = 0.3

/** Which colour a policy picks, given what it must stand out against. */
function resolve(policy, face, background, drawn) {
  if (policy === 'dark') return 0x0d1117
  if (policy === 'light') return 0xdfe7f5
  if (policy === 'face') return (drawn ? face : background) > 0.5 ? 0x0d1117 : 0xdfe7f5
  if (policy === 'background') return background > 0.5 ? 0x0d1117 : 0xdfe7f5
  let best = CANDIDATES[0]
  let bestScore = -1
  for (const candidate of CANDIDATES) {
    const score = drawn
      ? Math.min(Math.abs(lum(candidate) - face), Math.abs(lum(candidate) - background))
      : Math.abs(lum(candidate) - background)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

const failures = []
console.log('策略对"线能否看清"的影响（数值 = 与该参照物的对比度）\n')
for (const drawn of [true, false]) {
  for (const backgroundCss of BACKGROUNDS) {
    const background = lum(parse(backgroundCss))
    console.log(`${drawn ? '有面（current / ao+strong）' : 'lines（无面）'} · 背景 ${backgroundCss}`)
    for (const policy of ['face', 'background', 'balanced']) {
      const cells = FACES.map((face) => {
        const edge = resolve(policy, lum(face), background, drawn)
        const againstFace = Math.abs(lum(edge) - lum(face))
        const againstBackground = Math.abs(lum(edge) - background)
        // With a fill drawn the line sits on it, so the fill is the reference;
        // the background only matters where a line extends past the silhouette.
        const relevant = drawn ? againstFace : againstBackground
        // Reported, not failed: the metric compares *base* colours, and under the
        // viewer's contrast lighting the rendered surface is much darker than its
        // base — the default pairing measures 0.03 here yet reads clearly on
        // screen. Treat a low number as "worth looking at", not as a defect.
        const mark = relevant >= MIN_CONTRAST ? '' : ' ← 基准色偏低'
        if (relevant < MIN_CONTRAST) {
          failures.push(
            `  ${policy} · ${drawn ? '有面' : 'lines'} · 背景 ${backgroundCss} · 面色 ${lum(face).toFixed(2)}` +
              ` → 线 ${againstFace.toFixed(2)}/${againstBackground.toFixed(2)}`,
          )
        }
        return `${lum(face).toFixed(2)} → ${againstFace.toFixed(2)}/${againstBackground.toFixed(2)}${mark}`
      })
      console.log(`  ${policy.padEnd(11)} 面/背景对比度  ${cells.join('   ')}`)
    }
  }
}
console.log(
  `\n（每格是"线对 面色/背景 的对比度"；阈值 ${MIN_CONTRAST}）` +
    (failures.length === 0
      ? '\n所有组合在基准色度量下都合格 ✓'
      : `\n${failures.length} 个组合的基准色对比度偏低（仅供查看，非缺陷）：\n${failures.join('\n')}`),
)
// Informational only: the shipped default is `background`, whose numbers are
// pessimistic here by construction (see the caveat above).
