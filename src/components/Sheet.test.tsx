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
import { Sheet } from './Sheet'
import { useSheetClose, useSheetDirty } from './sheetStack'

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

/**
 * B67: only a drag-down was guarded. Escape, a scrim tap, and a text-selection
 * drag released over the scrim all discarded a half-typed amount. A sheet with
 * unsaved input now stays open (and nudges); the X stays the explicit discard.
 * The scrim closes only when the press both starts and ends on it.
 */
describe('Sheet: unsaved input is not lost by accident', () => {
  function Body({ dirty }: { dirty: boolean }) {
    useSheetDirty(dirty)
    return <input aria-label="Amount" />
  }
  const backdrop = () => document.querySelector('.sheet-backdrop') as HTMLElement
  const tapScrim = () => {
    fireEvent.pointerDown(backdrop())
    fireEvent.pointerUp(backdrop())
    fireEvent.click(backdrop())
  }

  it('Escape keeps a sheet with typed input open', () => {
    const onClose = vi.fn()
    renderInRoot(
      <Sheet kind="txn" title="T" onClose={onClose}>
        <Body dirty />
      </Sheet>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('Escape keeps a sheet marked dirty by its parent open', () => {
    const onClose = vi.fn()
    renderInRoot(
      <Sheet kind="account" title="A" onClose={onClose} dirty>
        <p>body</p>
      </Sheet>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a scrim tap keeps a sheet with typed input open', () => {
    const onClose = vi.fn()
    renderInRoot(
      <Sheet kind="txn" title="T" onClose={onClose}>
        <Body dirty />
      </Sheet>,
    )
    tapScrim()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a scrim tap closes a sheet with nothing typed', () => {
    const cleanClose = vi.fn()
    renderInRoot(
      <Sheet kind="txn" title="T" onClose={cleanClose}>
        <Body dirty={false} />
      </Sheet>,
    )
    tapScrim()
    expect(cleanClose).toHaveBeenCalledTimes(1)
  })

  it('a text-selection drag from a field released over the scrim does not close', () => {
    const onClose = vi.fn()
    renderInRoot(
      <Sheet kind="command" title="Tell Tally" onClose={onClose}>
        <Body dirty={false} />
      </Sheet>,
    )
    const field = screen.getByLabelText('Amount')
    fireEvent.pointerDown(field)
    fireEvent.pointerUp(backdrop())
    // The browser sends the click to the common ancestor: the backdrop.
    fireEvent.click(backdrop())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a press on the scrim released inside the sheet does not close', () => {
    const onClose = vi.fn()
    renderInRoot(
      <Sheet kind="txn" title="T" onClose={onClose}>
        <Body dirty={false} />
      </Sheet>,
    )
    fireEvent.pointerDown(backdrop())
    fireEvent.pointerUp(document.querySelector('.sheet-body') as HTMLElement)
    fireEvent.click(backdrop())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('the X still discards a sheet with typed input', () => {
    const onClose = vi.fn()
    renderInRoot(
      <Sheet kind="txn" title="T" onClose={onClose}>
        <Body dirty />
      </Sheet>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
