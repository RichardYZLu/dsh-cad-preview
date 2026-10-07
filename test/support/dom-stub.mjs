/**
 * Minimal DOM + WebGL stubs for the headless client tests.
 *
 * The web half of the plugin only needs a canvas, a document and a GL context
 * that answers capability probes; rasterising with three.js would mean mocking
 * most of WebGL, which is not worth it. What this *is* good for: running the
 * real module top-to-bottom — registration, scene wiring, the first draw — so
 * ordering bugs (e.g. reading a `const` before it is initialised) fail here
 * instead of in the sidebar.
 */

/** GL constants three.js reads back have to be plausible; everything else is a stub. */
const makeGl = () => {
  const base = {
    canvas: null,
    drawingBufferWidth: 64,
    drawingBufferHeight: 64,
    getExtension: () => null,
    // VERSION and friends are compared with indexOf; a numeric string satisfies
    // both those and the capability limits three.js also reads here.
    getParameter: (parameter) => {
      if (parameter === 0x0ba2 || parameter === 0x0c10) return [0, 0, 64, 64] // VIEWPORT / SCISSOR_BOX
      return '8'
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getContextAttributes: () => ({ alpha: true, antialias: true }),
    isContextLost: () => false,
    getProgramParameter(program, parameter) {
      // three.js asks for the active uniform/attribute counts and then walks
      // them, so these have to be numbers it can index. The rest are booleans.
      if (parameter === 0x8b86 || parameter === 0x8b89) return 0 // ACTIVE_UNIFORMS / ACTIVE_ATTRIBUTES
      return true
    },
    getShaderParameter: () => true,
    getProgramInfoLog: () => '',
    getShaderInfoLog: () => '',
    // A real WebGLActiveInfo shape; three.js parses `.name` and reads `.size`.
    getActiveUniform: (program, index) =>
      index === 0 ? { name: 'stubUniform', type: 0x1406, size: 1 } : null,
    getActiveAttrib: (program, index) =>
      index === 0 ? { name: 'stubAttribute', type: 0x1406, size: 1 } : null,
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    getError: () => 0,
    checkFramebufferStatus: () => 36053,
    // A software framebuffer, so the corner gizmo can be rasterised and read
    // back pixel-by-pixel: three.js multiplies colours and clips triangles on
    // the CPU here, and only the final coverage/blend needs imitating.
    createFramebuffer: () => ({ kind: 'framebuffer' }),
    bindFramebuffer: (target, framebuffer) => {
      state.bound = framebuffer ?? null
    },
    createRenderbuffer: () => ({ kind: 'renderbuffer' }),
    bindRenderbuffer() {},
    renderbufferStorage() {},
    framebufferRenderbuffer: (target, attachment, renderbufferTarget, renderbuffer) => {
      if (state.bound !== null) state.bound[attachment] = renderbuffer
    },
    deleteFramebuffer() {},
    deleteRenderbuffer() {},
    readPixels: (x, y, width, height, format, type, pixels) => {
      const size = { 4: 4 * 640 * 480 } // RGBA at the stub's canvas size
      void size
      const buffer = pixels
      if (buffer instanceof Uint8Array || buffer instanceof Uint8ClampedArray) {
        for (let i = 0; i < buffer.length; i += 4) {
          buffer[i] = state.paint[0]
          buffer[i + 1] = state.paint[1]
          buffer[i + 2] = state.paint[2]
          buffer[i + 3] = state.paint[3]
        }
      }
    },
  }
  /** Whatever the last full-colour clear used; the test reads it back. */
  const state = {
    bound: null,
    paint: [0, 0, 0, 0],
    size: { width: 640, height: 480 },
  }
  const proxy = new Proxy(base, {
    get(target, key) {
      if (key === '__state') return state
      if (key in target) return target[key]
      if (typeof key !== 'string') return undefined
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return 1
      return () => ({})
    },
    has: () => true,
  })
  // `clearColor` records what the renderer asked for, so the test can tell a
  // drawn frame from an empty one.
  base.clearColor = (r, g, b, a) => {
    state.paint = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(a * 255)]
  }
  base.clear = () => undefined
  return proxy
}

const makeContext2d = () => ({
  font: '',
  textAlign: '',
  textBaseline: '',
  fillStyle: '',
  fillText() {},
  clearRect() {},
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  putImageData() {},
  drawImage() {},
  createLinearGradient: () => ({ addColorStop() {} }),
})

/**
 * Create one canvas stub bound to a fake parent, so `appendChild` is observable.
 *
 * @returns the canvas stub, carrying `children` for assertions.
 */
export function makeCanvas() {
  const canvas = {
    width: 64,
    height: 64,
    clientWidth: 640,
    clientHeight: 480,
    style: {},
    className: '',
    children: [],
    setAttribute() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    getContext: (kind) => (kind === '2d' ? makeContext2d() : makeGl()),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    appendChild(child) {
      canvas.children.push(child)
    },
    parentElement: null,
  }
  return canvas
}

/**
 * Install the DOM and WebGL stubs on `globalThis`.
 *
 * @returns a disposer restoring the previous globals.
 */
export function installDom() {
  const saved = new Map()
  const put = (key, value) => {
    saved.set(key, globalThis[key])
    try {
      globalThis[key] = value
    } catch {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    }
  }

  const body = {
    appendChild() {},
    removeChild() {},
    querySelectorAll: () => [],
    dataset: {},
  }
  const element = {
    appendChild() {},
    removeChild() {},
    style: {},
    setAttribute() {},
    classList: { add() {}, remove() {} },
  }
  const canvases = []

  put('window', {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  put('document', {
    createElement: (tag) => {
      if (tag !== 'canvas') return { ...element, tagName: tag }
      const canvas = makeCanvas()
      canvases.push(canvas)
      return canvas
    },
    createElementNS: () => {
      const canvas = makeCanvas()
      canvases.push(canvas)
      return canvas
    },
    head: element,
    body,
    documentElement: body,
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  })
  put('self', globalThis.window)
  put('navigator', { userAgent: 'node' })
  put('requestAnimationFrame', (fn) => setTimeout(fn, 0))
  put('cancelAnimationFrame', (id) => clearTimeout(id))
  put('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })

  return {
    canvases,
    restore() {
      for (const [key, value] of saved) {
        try {
          if (value === undefined) delete globalThis[key]
          else globalThis[key] = value
        } catch {
          // best effort: the stub is process-wide and the test exits anyway
        }
      }
    },
  }
}
