// @vitest-environment jsdom
/**
 * Script motion (S3-motion): a figure settles only when its text changes (never
 * on first render, never when the same figure re-renders), Reduce Motion skips
 * it, and a theme change is one view transition (skipped when nothing changes
 * or under Reduce Motion).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { useSettle } from './motion'
import { useTheme } from './useTheme'

function Figure({ text }: { text: string }) {
  const ref = useRef<HTMLElement>(null)
  useSettle(ref, '.fig')
  return (
    <section ref={ref}>
      <span className="fig">{text}</span>
    </section>
  )
}

const reduce = (on: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: on && q.includes('reduce'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))

let animate: ReturnType<typeof vi.fn>

beforeEach(() => {
  animate = vi.fn()
  ;(Element.prototype as unknown as { animate: unknown }).animate = animate
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (Element.prototype as unknown as { animate?: unknown }).animate
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition
  document.documentElement.removeAttribute('data-theme')
  localStorage.clear()
})

describe('useSettle', () => {
  it('does not play on first render or when the same figure re-renders', () => {
    reduce(false)
    const { rerender } = render(<Figure text="$1,200.00" />)
    rerender(<Figure text="$1,200.00" />)
    expect(animate).not.toHaveBeenCalled()
  })

  it('plays once, from clear and .12em low, when the figure changes', () => {
    reduce(false)
    const { rerender } = render(<Figure text="$1,200.00" />)
    rerender(<Figure text="$1,323.45" />)
    expect(animate).toHaveBeenCalledTimes(1)
    const [frames, timing] = animate.mock.calls[0]
    expect(frames[0]).toEqual({ opacity: 0, transform: 'translateY(0.12em)' })
    expect(frames[1]).toEqual({ opacity: 1, transform: 'none' })
    expect(timing.duration).toBeGreaterThan(0)
    // The animated node is the figure itself, and its text is the new value.
    expect(animate.mock.contexts[0].textContent).toBe('$1,323.45')
  })

  it('is skipped under Reduce Motion', () => {
    reduce(true)
    const { rerender } = render(<Figure text="$1,200.00" />)
    rerender(<Figure text="$9.99" />)
    expect(animate).not.toHaveBeenCalled()
  })
})

describe('useTheme setPref', () => {
  it('dissolves through one view transition when the theme changes', () => {
    reduce(false)
    document.documentElement.setAttribute('data-theme', 'dark')
    const vt = vi.fn((update: () => void) => update())
    ;(document as unknown as { startViewTransition: unknown }).startViewTransition = vt
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setPref('light'))
    expect(vt).toHaveBeenCalledTimes(1)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(result.current.pref).toBe('light')
    expect(localStorage.getItem('tally-theme')).toBe('light')
  })

  it('does not dissolve when the shown theme stays the same', () => {
    reduce(false)
    document.documentElement.setAttribute('data-theme', 'dark')
    const vt = vi.fn((update: () => void) => update())
    ;(document as unknown as { startViewTransition: unknown }).startViewTransition = vt
    const { result } = renderHook(() => useTheme())
    // 'system' resolves to dark here, which is already on screen.
    act(() => result.current.setPref('dark'))
    act(() => result.current.setPref('system'))
    expect(vt).not.toHaveBeenCalled()
    expect(result.current.pref).toBe('system')
  })

  it('swaps instantly under Reduce Motion', () => {
    reduce(true)
    document.documentElement.setAttribute('data-theme', 'dark')
    const vt = vi.fn((update: () => void) => update())
    ;(document as unknown as { startViewTransition: unknown }).startViewTransition = vt
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setPref('light'))
    expect(vt).not.toHaveBeenCalled()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})
