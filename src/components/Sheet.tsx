import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { Ctx, getStack, isTop, register, unregister, type SheetCtx, type SheetKind } from './sheetStack'

/**
 * The one sheet primitive. Every sheet (transaction, account, bank, settings)
 * is this shell with its own body:
 *
 *   .sheet-backdrop            portaled to <body>; ::before is the scrim
 *     .sheet[data-sheet]       role=dialog, opaque surface-1, height-capped
 *       .sheet-drag            grab bar + head (the only drag handle)
 *         .sheet-grab
 *         .sheet-head          headLeading, h2 title, .sheet-close
 *       .sheet-body            scrolls; children
 *       footer.sheet-actions   pinned; `actions` and anything a body renders
 *                              through <SheetActions>
 *
 * Fail-safes: with no matchMedia or no Element.animate, or under Reduce Motion,
 * close() calls onClose synchronously. Otherwise it plays the exit and a timer
 * calls onClose if animationend never arrives. #root is made inert while any
 * sheet is open (reference-counted), and released even if a parent forgets to
 * unmount a closed sheet, so the app can never sit inert behind a dead scrim.
 */

const mq = (q: string) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches

/** Close without an exit animation: Reduce Motion, or no way to animate or to ask. */
function instantClose(): boolean {
  return (
    typeof window.matchMedia !== 'function' ||
    typeof Element.prototype.animate !== 'function' ||
    mq('(prefers-reduced-motion: reduce)')
  )
}

/** var(--dur-sheet-out) in ms (280 when the token is unavailable, e.g. in tests). */
function exitMs(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-sheet-out').trim()
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return 280
  return /ms$/.test(v) ? n : /s$/.test(v) ? n * 1000 : n
}

/** Renders its children in the sheet's pinned footer (outside the scrolling body). */
export function SheetActions({ children }: { children: ReactNode }) {
  const ctx = useContext(Ctx)
  if (!ctx?.actionsEl) return null
  return createPortal(children, ctx.actionsEl)
}

const FIELD = 'input, textarea, select'
const INTERACTIVE = 'button, a, input, textarea, select, label'
// Tab stops only: an unchosen option of a roving radio group carries tabindex -1
// and is reached with the arrow keys, so it is never the trap's first or last.
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]',
].map((s) => `${s}:not([tabindex="-1"])`).join(', ')

interface Props {
  kind: SheetKind
  title: ReactNode
  onClose: () => void
  /** Unsaved edits: a drag-down, Escape or a scrim tap nudges instead of closing. */
  dirty?: boolean
  /** Pinned footer content (bodies can also use <SheetActions>). */
  actions?: ReactNode
  /** Before the title in the head (e.g. a merchant logo). */
  headLeading?: ReactNode
  children: ReactNode
}

export function Sheet({ kind, title, onClose, dirty, actions, headLeading, children }: Props) {
  const id = useId()
  const titleId = `${id}-title`
  const backdropRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null)

  // The element that had focus when the sheet opened (read during the first
  // render, before any autoFocus inside the sheet moves it).
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null,
  )

  // Set by the body when focus should not go back to the opener on close (a
  // delete removes the row that opened the sheet).
  const returnTo = useRef<HTMLElement | null>(null)
  const setReturnFocus = useCallback((el: HTMLElement | null) => {
    returnTo.current = el
  }, [])

  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  })
  const dirtyProp = useRef(!!dirty)
  const dirtyBody = useRef(false)
  useLayoutEffect(() => {
    dirtyProp.current = !!dirty
  })

  const closingRef = useRef(false)
  const doneRef = useRef(false)
  const timerRef = useRef<number | undefined>(undefined)

  const finish = useCallback(() => {
    window.clearTimeout(timerRef.current)
    if (doneRef.current) return
    doneRef.current = true
    // Release the page even if the parent keeps a closed sheet mounted.
    unregister(id)
    onCloseRef.current()
  }, [id])

  const close = useCallback(() => {
    if (closingRef.current || doneRef.current) return
    closingRef.current = true
    if (instantClose()) {
      finish()
      return
    }
    setClosing(true)
    timerRef.current = window.setTimeout(finish, exitMs() + 100)
  }, [finish])

  const setDirty = useCallback((d: boolean) => {
    dirtyBody.current = d
  }, [])

  /** Unsaved edits kept the sheet open: say so. A small dip of the sheet, or
   *  under Reduce Motion (no movement) a pulse of the X, the explicit discard. */
  const nudge = useCallback((delay: number) => {
    const sheet = sheetRef.current
    if (!sheet || typeof sheet.animate !== 'function') return
    if (instantClose()) {
      sheet.querySelector('.sheet-close')?.animate([{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }], { duration: 480, delay })
      return
    }
    sheet.animate(
      [{ transform: 'translate3d(0, 0, 0)' }, { transform: 'translate3d(0, 8px, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 260, delay, easing: 'cubic-bezier(.22,1,.36,1)' },
    )
  }, [])

  /** Escape and the scrim: close, unless there are unsaved edits (the X and
   *  the body's own Save/Delete close through close() and always do). */
  const requestClose = useCallback(() => {
    if (dirtyProp.current || dirtyBody.current) {
      nudge(0)
      return
    }
    close()
  }, [close, nudge])

  // Register in the stack (inert on the first sheet) for as long as it is mounted.
  useEffect(() => {
    if (doneRef.current) return
    register({ id, kind })
    return () => unregister(id)
  }, [id, kind])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  // Focus: the sheet itself unless something inside took focus (autoFocus).
  // On unmount, hand focus back to the opener (a microtask later, so a
  // StrictMode remount, which re-registers synchronously, is not mistaken
  // for a real close).
  useEffect(() => {
    const el = sheetRef.current
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
    return () => {
      queueMicrotask(() => {
        if (getStack().some((e) => e.id === id)) return
        // The body's override wins: the opener may still be in the page at
        // this point and leave a moment later (a deleted row).
        const target = returnTo.current?.isConnected ? returnTo.current : opener
        if (target && target !== document.body && target.isConnected && typeof target.focus === 'function') {
          target.focus({ preventScroll: true })
        }
      })
    }
  }, [id, opener])

  // Keys: only the top-most sheet answers Escape and traps Tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop(id)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        requestClose()
        return
      }
      if (e.key !== 'Tab') return
      const el = sheetRef.current
      if (!el) return
      const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.closest('[hidden], [inert]'))
      // Skip what is not rendered (display:none); without layout (tests) keep all.
      const shown = all.filter((n) => n.getClientRects().length > 0 || n === document.activeElement)
      const items = shown.length > 1 || all.length <= 1 ? shown : all
      if (items.length === 0) {
        e.preventDefault()
        el.focus({ preventScroll: true })
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === el || !el.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, requestClose])

  // Keyboard inset: keep the sheet (and its pinned actions) above the iOS
  // keyboard. --kb is the part of the layout viewport the keyboard covers.
  useEffect(() => {
    const vv = window.visualViewport
    const bd = backdropRef.current
    if (!vv || !bd) return
    const update = () => {
      const raw = Math.abs(vv.scale - 1) > 0.01 ? 0 : window.innerHeight - vv.height - vv.offsetTop
      const kb = raw > 60 ? Math.round(raw) : 0
      bd.style.setProperty('--kb', `${kb}px`)
      bd.toggleAttribute('data-kb', kb > 0)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  // A focused field scrolls into view once the keyboard has settled.
  const focusTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(focusTimer.current), [])
  const onFocusCapture = (e: ReactFocusEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (!t.matches?.(FIELD)) return
    window.clearTimeout(focusTimer.current)
    focusTimer.current = window.setTimeout(() => {
      if (document.activeElement === t) t.scrollIntoView?.({ block: 'nearest' })
    }, 280)
  }

  // ---- Drag to dismiss (grab bar + head only; never from the body) ----------
  const drag = useRef<{ pointer: number; y0: number; dy: number; samples: { y: number; t: number }[] } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || closingRef.current || mq('(min-width: 920px)')) return
    if ((e.target as Element).closest(INTERACTIVE)) return
    const sheet = sheetRef.current
    const bd = backdropRef.current
    if (!sheet || !bd) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { pointer: e.pointerId, y0: e.clientY, dy: 0, samples: [{ y: e.clientY, t: performance.now() }] }
    sheet.classList.add('is-dragging')
    bd.classList.add('is-dragging')
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const sheet = sheetRef.current
    const bd = backdropRef.current
    if (!d || e.pointerId !== d.pointer || !sheet || !bd) return
    const raw = e.clientY - d.y0
    // Down follows the finger; up resists (a fifth of the travel).
    const dy = raw > 0 ? raw : raw / 5
    d.dy = dy
    d.samples.push({ y: e.clientY, t: performance.now() })
    if (d.samples.length > 8) d.samples.shift()
    sheet.style.transform = `translate3d(0, ${dy}px, 0)`
    const h = sheet.offsetHeight || 1
    bd.style.setProperty('--drag', String(Math.min(1, Math.max(0, dy / h))))
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current
    const sheet = sheetRef.current
    const bd = backdropRef.current
    if (!d || e.pointerId !== d.pointer) return
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (!sheet || !bd) return
    sheet.classList.remove('is-dragging')
    bd.classList.remove('is-dragging')
    const now = performance.now()
    const recent = d.samples.find((s) => now - s.t <= 100) ?? d.samples[0]
    const last = d.samples[d.samples.length - 1]
    const v = last.t > recent.t ? (last.y - recent.y) / (last.t - recent.t) : 0
    const wantsClose = !cancelled && d.dy > 0 && (d.dy > 110 || v > 0.6)
    const dirtyNow = dirtyProp.current || dirtyBody.current
    if (wantsClose && !dirtyNow) {
      // The exit animation starts from where the finger left the sheet.
      close()
      return
    }
    // Spring back (the .sheet transform transition), and nudge when unsaved
    // edits are what kept it open.
    sheet.style.transform = ''
    bd.style.setProperty('--drag', '0')
    if (wantsClose && dirtyNow) nudge(300)
  }

  // The scrim closes only when the press both starts and ends on it. A
  // text-selection drag from a field released over the scrim (or a press on
  // the scrim released in the sheet) clicks the backdrop too: the click goes
  // to the nearest common ancestor of the press and the release.
  const pressOnScrim = useRef(false)
  const releaseOnScrim = useRef(false)

  const onAnimationEnd = (e: ReactAnimationEvent<HTMLDivElement>) => {
    if (closingRef.current && e.target === e.currentTarget) finish()
  }

  const ctx = useMemo<SheetCtx>(
    () => ({ close, setDirty, actionsEl, opener, setReturnFocus }),
    [close, setDirty, actionsEl, opener, setReturnFocus],
  )

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={backdropRef}
      className={`sheet-backdrop${closing ? ' is-closing' : ''}`}
      onPointerDown={(e) => {
        pressOnScrim.current = e.target === e.currentTarget
      }}
      onPointerUp={(e) => {
        releaseOnScrim.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        const onScrim = e.target === e.currentTarget && pressOnScrim.current && releaseOnScrim.current
        pressOnScrim.current = false
        releaseOnScrim.current = false
        if (onScrim) requestClose()
      }}
    >
      <div
        ref={sheetRef}
        className={`sheet${closing ? ' is-closing' : ''}`}
        data-sheet={kind}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onAnimationEnd={onAnimationEnd}
        onFocusCapture={onFocusCapture}
      >
        <div
          className="sheet-drag"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
        >
          <div className="sheet-grab" aria-hidden="true" />
          <div className="sheet-head">
            {headLeading}
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="sheet-close" onClick={close} aria-label="Close">
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
        <Ctx.Provider value={ctx}>
          <div className="sheet-body">{children}</div>
        </Ctx.Provider>
        <footer className="sheet-actions" ref={setActionsEl}>
          {actions}
        </footer>
      </div>
    </div>,
    document.body,
  )
}
