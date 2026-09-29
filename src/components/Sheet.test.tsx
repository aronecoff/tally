// @vitest-environment jsdom
/**
 * The sheet primitive's fail-safes. A sheet must never leave the app inert
 * behind a dead scrim: close() must reach onClose even when there is no way to
 * animate (no matchMedia / no Element.animate) or when animationend never
 * arrives, and #root's inert is reference-counted across stacked sheets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { Sheet, useSheetClose } from './Sheet'

function CloseButton({ label = 'Done' }: { label?: string }) {
  const close = useSheetClose()
  return <button onClick={close}>{label}</button>
}

let root: HTMLElement

beforeEach(() => {
  root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
})

afterEach(() => {
  cleanup()
  root.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (Element.prototype as { animate?: unknown }).animate
})

const renderInRoot = (ui: ReactElement) => render(ui, { container: root })

describe('Sheet fail-safes', () => {
  it('without matchMedia, close() calls onClose synchronously and releases #root', () => {
    expect(typeof window.matchMedia).toBe('undefined')
    const onClose = vi.fn()
    renderInRoot(
      <Sheet kind="txn" title="T" onClose={onClose}>
        <CloseButton />
      </Sheet>,
    )
    expect(root.hasAttribute('inert')).toBe(true)
    fireEvent.click(screen.getByText('Done'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(root.hasAttribute('inert')).toBe(false)
  })

  it('with matchMedia but no animationend, the fallback timer calls onClose and #root loses inert', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })),
    )
    ;(Element.prototype as { animate?: unknown }).animate = vi.fn()
    const onClose = vi.fn()
    renderInRoot(
      <Sheet kind="account" title="A" onClose={onClose}>
        <CloseButton />
      </Sheet>,
    )
    fireEvent.click(screen.getByText('Done'))
    // Closing plays the exit first.
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.sheet')?.classList.contains('is-closing')).toBe(true)
    // --dur-sheet-out (280ms when the token is unavailable) + 100ms.
    act(() => {
      vi.advanceTimersByTime(379)
    })
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(root.hasAttribute('inert')).toBe(false)
  })

  it('keeps #root inert until every stacked sheet has closed', () => {
    function Two() {
      const [a, setA] = useState(true)
      const [b, setB] = useState(true)
      return (
        <>
          {a && (
            <Sheet kind="settings" title="Lower" onClose={() => setA(false)}>
              <CloseButton label="Close lower" />
            </Sheet>
          )}
          {b && (
            <Sheet kind="bank" title="Upper" onClose={() => setB(false)}>
              <CloseButton label="Close upper" />
            </Sheet>
          )}
        </>
      )
    }
    renderInRoot(<Two />)
    expect(root.hasAttribute('inert')).toBe(true)
    fireEvent.click(screen.getByText('Close upper'))
    expect(screen.queryByText('Close upper')).toBeNull()
    expect(root.hasAttribute('inert')).toBe(true)
    fireEvent.click(screen.getByText('Close lower'))
    expect(root.hasAttribute('inert')).toBe(false)
  })

  it('Escape closes only the top-most sheet', () => {
    const lower = vi.fn()
    const upper = vi.fn()
    renderInRoot(
      <>
        <Sheet kind="settings" title="Lower" onClose={lower}>
          <p>lower</p>
        </Sheet>
        <Sheet kind="bank" title="Upper" onClose={upper}>
          <p>upper</p>
        </Sheet>
      </>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(upper).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()
  })

  it('is a labelled modal dialog, focused on open, and hands focus back to its opener', async () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          {open && (
            <Sheet kind="settings" title="Settings" onClose={() => setOpen(false)}>
              <CloseButton />
            </Sheet>
          )}
        </>
      )
    }
    renderInRoot(<Host />)
    const opener = screen.getByText('Open')
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('data-sheet')).toBe('settings')
    expect(document.activeElement).toBe(dialog)
    fireEvent.click(screen.getByText('Done'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(opener)
  })

  it('Tab from the last focusable element stays inside the sheet', () => {
    renderInRoot(
      <Sheet kind="txn" title="T" onClose={() => {}}>
        <button>First</button>
        <button>Last</button>
      </Sheet>,
    )
    // Focus order inside: the head's Close, then First, then Last.
    const last = screen.getByText('Last')
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})
