/**
 * Fixture builders for the headless smoke test.
 *
 * Each builder writes a real file of the format the sidebar viewer claims, so
 * the test exercises the same parsers and the same host route the browser uses
 * rather than a mock.
 */
import { deflateRawSync, crc32 } from 'node:zlib'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Unit cube corners shared by the textual formats. */
const CUBE_VERTICES = [
  [0, 0, 0],
  [10, 0, 0],
  [10, 10, 0],
  [0, 10, 0],
  [0, 0, 10],
  [10, 0, 10],
  [10, 10, 10],
  [0, 10, 10],
]

/** Twelve triangles (two per face) over CUBE_VERTICES. */
const CUBE_FACES = [
  [0, 2, 1], [0, 3, 2],
  [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6],
  [3, 0, 4], [3, 4, 7],
]

/** Binary STL of the unit cube. */
export function writeStl(dir) {
  const path = join(dir, 'cube.stl')
  const triangles = CUBE_FACES.length
  const buffer = Buffer.alloc(84 + triangles * 50)
  buffer.write('dsh-cad-preview cube', 0, 'ascii')
  buffer.writeUInt32LE(triangles, 80)
  let offset = 84
  for (const [a, b, c] of CUBE_FACES) {
    offset += 12 // normal left at zero: the loader recomputes from winding
    for (const index of [a, b, c]) {
      const vertex = CUBE_VERTICES[index]
      for (const value of vertex) {
        buffer.writeFloatLE(value, offset)
        offset += 4
      }
    }
    buffer.writeUInt16LE(0, offset)
    offset += 2
  }
  writeFileSync(path, buffer)
  return path
}

/** ASCII OBJ of the unit cube, as an exporter would write it. */
export function writeObj(dir) {
  const path = join(dir, 'cube.obj')
  const lines = ['# dsh-cad-preview fixture', 'o cube']
  for (const [x, y, z] of CUBE_VERTICES) lines.push(`v ${x} ${y} ${z}`)
  for (const [a, b, c] of CUBE_FACES) lines.push(`f ${a + 1} ${b + 1} ${c + 1}`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/** ASCII PLY of the unit cube. */
export function writePly(dir) {
  const path = join(dir, 'cube.ply')
  const lines = [
    'ply',
    'format ascii 1.0',
    'comment dsh-cad-preview fixture',
    `element vertex ${CUBE_VERTICES.length}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${CUBE_FACES.length}`,
    'property list uchar int vertex_indices',
    'end_header',
  ]
  for (const [x, y, z] of CUBE_VERTICES) lines.push(`${x} ${y} ${z}`)
  for (const [a, b, c] of CUBE_FACES) lines.push(`3 ${a} ${b} ${c}`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/**
 * Build one stored/deflated ZIP entry pair (local header elsewhere; this
 * returns the deflated payload plus the fields both headers share).
 */
function zipEntry(name, text) {
  const nameBytes = Buffer.from(name, 'utf8')
  const raw = Buffer.from(text, 'utf8')
  const deflated = deflateRawSync(raw)
  const data = deflated.length < raw.length ? deflated : raw
  return {
    nameBytes,
    raw,
    data,
    method: deflated.length < raw.length ? 8 : 0,
    crc: crc32(raw) >>> 0,
  }
}

/**
 * Write a minimal but structurally valid 3MF of the unit cube.
 *
 * 3MF is an OPC package: a ZIP with `[Content_Types].xml`, a relationship part
 * and the model part. Written by hand (no zip dependency) so the test can run
 * from a bare checkout.
 */
export function write3mf(dir) {
  const path = join(dir, 'cube.3mf')
  const vertices = CUBE_VERTICES.map(
    ([x, y, z]) => `      <vertex x="${x}" y="${y}" z="${z}" />`,
  ).join('\n')
  const triangles = CUBE_FACES.map(
    ([a, b, c]) => `      <triangle v1="${a}" v2="${b}" v3="${c}" />`,
  ).join('\n')

  const entries = [
    zipEntry(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`,
    ),
    zipEntry(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`,
    ),
    zipEntry(
      '3D/3dmodel.model',
      `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
${vertices}
        </vertices>
        <triangles>
${triangles}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>`,
    ),
  ]

  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date: 1980-01-01, the ZIP epoch
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.raw.length, 22)
    local.writeUInt16LE(entry.nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, entry.nameBytes, entry.data)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0, 8)
    directory.writeUInt16LE(entry.method, 10)
    directory.writeUInt16LE(0, 12)
    directory.writeUInt16LE(0x21, 14)
    directory.writeUInt32LE(entry.crc, 16)
    directory.writeUInt32LE(entry.data.length, 20)
    directory.writeUInt32LE(entry.raw.length, 24)
    directory.writeUInt16LE(entry.nameBytes.length, 28)
    directory.writeUInt16LE(0, 30)
    directory.writeUInt16LE(0, 32)
    directory.writeUInt16LE(0, 34)
    directory.writeUInt16LE(0, 36)
    directory.writeUInt32LE(0, 38)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, entry.nameBytes)

    offset += 30 + entry.nameBytes.length + entry.data.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  writeFileSync(path, Buffer.concat([...chunks, centralBuffer, end]))
  return path
}

/**
 * Copy the downloaded B-rep fixtures into place and build the mesh ones.
 *
 * The STEP/IGES/BREP fixtures are the small cube samples from occt-import-js's
 * own test suite (downloaded once by `scripts/fetch-fixtures.mjs`); the mesh
 * formats are generated here so no further download is needed.
 *
 * @param dir - absolute directory to write into.
 * @returns the fixture paths keyed by suffix.
 */
export function ensureFixtures(dir) {
  mkdirSync(dir, { recursive: true })
  const source = new URL('.', import.meta.url)
  const from = (name) => fileURLToPath(new URL(name, source))
  const copy = (name, target) => {
    const path = join(dir, target)
    copyFileSync(from(name), path)
    return path
  }
  return {
    step: copy('cube.step', 'work.step'),
    stp: copy('cube.step', 'work.stp'),
    iges: copy('cube.igs', 'work.igs'),
    brep: copy('cube.brep', 'work.brep'),
    stl: writeStl(dir),
    obj: writeObj(dir),
    ply: writePly(dir),
    '3mf': write3mf(dir),
  }
}
