/**
 * Squarified treemap (Bruls, Huizing & van Wijk 2000).
 *
 * Lays items out as rectangles whose AREA is proportional to their value, while
 * keeping each rectangle as close to square as possible (slivers are unreadable
 * and unlabelable). Used by the Budget tab to show how the monthly limit is
 * carved up — so a $2,875 rent commitment physically dominates a $150 one
 * instead of being just another equal-height row in a list.
 *
 * Works in an abstract W×H coordinate space; the caller renders with percentages
 * against a container locked to the same aspect ratio, so the computed aspect
 * ratios survive to the screen.
 */

export interface TreeRect {
  x: number
  y: number
  w: number
  h: number
}

export interface TreeItem<T> {
  key: string
  /** Must be > 0 to be laid out; non-positive values are dropped. */
  value: number
  data: T
}

export interface TreeCell<T> extends TreeItem<T> {
  rect: TreeRect
}

/**
 * Worst (largest) aspect ratio in a row, given the row's total area and the
 * length of the side it's laid along. Lower is squarer — the value the
 * algorithm minimizes when deciding whether to keep growing a row.
 */
function worstRatio(areas: number[], rowArea: number, side: number): number {
  if (rowArea <= 0 || side <= 0) return Infinity
  let max = -Infinity
  let min = Infinity
  for (const a of areas) {
    if (a > max) max = a
    if (a < min) min = a
  }
  if (min <= 0) return Infinity
  const s2 = rowArea * rowArea
  const l2 = side * side
  return Math.max((l2 * max) / s2, s2 / (l2 * min))
}

export function squarify<T>(items: TreeItem<T>[], width: number, height: number): TreeCell<T>[] {
  const out: TreeCell<T>[] = []
  const usable = items.filter((i) => i.value > 0)
  const total = usable.reduce((s, i) => s + i.value, 0)
  if (total <= 0 || width <= 0 || height <= 0) return out

  // Scale values into area units for this canvas so areas sum to width*height.
  const scale = (width * height) / total
  const nodes = usable.map((i) => ({ item: i, area: i.value * scale }))

  let free: TreeRect = { x: 0, y: 0, w: width, h: height }
  let i = 0

  while (i < nodes.length && free.w > 1e-6 && free.h > 1e-6) {
    // Rows run along the SHORTER side — that's what keeps cells near-square.
    const side = Math.min(free.w, free.h)
    const row: number[] = []
    let rowArea = 0
    const start = i

    while (i < nodes.length) {
      const next = nodes[i].area
      const before = row.length ? worstRatio(row, rowArea, side) : Infinity
      const after = worstRatio([...row, next], rowArea + next, side)
      // Keep adding while the row's squareness improves (or it's the first cell).
      if (row.length === 0 || after <= before) {
        row.push(next)
        rowArea += next
        i++
      } else break
    }

    // Lay the row out as a strip of `thickness` across the free rect.
    const thickness = rowArea / side
    const horizontal = free.w >= free.h // strip is a vertical column on the left
    let offset = 0
    for (let k = 0; k < row.length; k++) {
      const len = row[k] / thickness
      const item = nodes[start + k].item
      out.push({
        ...item,
        rect: horizontal
          ? { x: free.x, y: free.y + offset, w: thickness, h: len }
          : { x: free.x + offset, y: free.y, w: len, h: thickness },
      })
      offset += len
    }

    free = horizontal
      ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
      : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness }
  }

  return out
}
