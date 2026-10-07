import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'

/**
 * The sheet stack and the hooks a sheet body uses, apart from the <Sheet>
 * component itself (a file that exports hooks beside components breaks Fast
 * Refresh). Sheet.tsx registers each open sheet here.
 */

export type SheetKind = 'txn' | 'account' | 'bank' | 'settings' | 'command'

export interface Entry {
  id: string
  kind: SheetKind
}

// ---- Module-level stack: top-most sheet handles keys; inert is ref-counted ----
let stack: readonly Entry[] = []
let inertCount = 0
const subscribers = new Set<() => void>()

function setRootInert(on: boolean) {
  const root = document.getElementById('root')
  if (!root) return
  if (on) root.setAttribute('inert', '')
  else root.removeAttribute('inert')
}

export function register(entry: Entry) {
  if (stack.some((e) => e.id === entry.id)) return
  stack = [...stack, entry]
  inertCount++
  if (inertCount === 1) setRootInert(true)
  subscribers.forEach((f) => f())
}

export function unregister(id: string) {
  if (!stack.some((e) => e.id === id)) return
  stack = stack.filter((e) => e.id !== id)
  inertCount = Math.max(0, inertCount - 1)
  if (inertCount === 0) setRootInert(false)
  subscribers.forEach((f) => f())
}

export const isTop = (id: string) => stack.length > 0 && stack[stack.length - 1].id === id

function subscribe(f: () => void) {
  subscribers.add(f)
  return () => {
    subscribers.delete(f)
  }
}
export const getStack = () => stack

/** The open sheets, bottom to top (e.g. to hide the reconnect banner while the bank sheet is up). */
export function useOpenSheets(): readonly Entry[] {
  return useSyncExternalStore(subscribe, getStack, getStack)
}

// ---- Context: close, dirty and the actions slot for the body ----------------
export interface SheetCtx {
  close: () => void
  setDirty: (dirty: boolean) => void
  actionsEl: HTMLElement | null
  /** What had focus when the sheet opened (focus goes back there on close). */
  opener: HTMLElement | null
  /** Where focus goes on close instead of the opener (a row about to be removed). */
  setReturnFocus: (el: HTMLElement | null) => void
}
export const Ctx = createContext<SheetCtx | null>(null)

function noop() {}

/** Close the enclosing sheet with its exit animation (onClose runs after it). */
export function useSheetClose(): () => void {
  const ctx = useContext(Ctx)
  return ctx ? ctx.close : noop
}

/** The opener of the enclosing sheet, and a way to send focus elsewhere when
 *  it closes (the opener can be the very row the sheet removes). */
export function useSheetFocusReturn(): Pick<SheetCtx, 'opener' | 'setReturnFocus'> {
  const ctx = useContext(Ctx)
  return { opener: ctx?.opener ?? null, setReturnFocus: ctx?.setReturnFocus ?? noop }
}

/** Report unsaved edits from inside the body: a drag-down, Escape or a scrim
 *  tap then keeps the sheet open (and nudges) instead of closing it. */
export function useSheetDirty(dirty: boolean) {
  const ctx = useContext(Ctx)
  const setDirty = ctx?.setDirty
  useEffect(() => {
    setDirty?.(dirty)
  }, [setDirty, dirty])
}
