/**
 * A minimal element, enough for the sampler page's UI wiring.
 *
 * @param tag - element name or id, used only for labelling.
 * @returns a stub element.
 */
export function createElementStub(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    id: String(tag),
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    children: [],
    dataset: {},
    appendChild(child) {
      this.children.push(child)
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child)
    },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    classList: {
      add() {},
      remove() {},
      // Real elements have this, and the page uses it to light the active button.
      toggle() {},
      contains: () => false,
    },
    getContext: () => null,
  }
}
