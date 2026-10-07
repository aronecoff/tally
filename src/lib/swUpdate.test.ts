// @vitest-environment jsdom
/**
 * Delivering a deploy without losing an edit:
 *  - B99: a first-ever visit is uncontrolled, and clientsClaim then fires
 *    controllerchange for the worker this page just installed. That is not an
 *    update, so it must not reload the page.
 *  - B65: an update waits while a sheet is open, even when the app goes to the
 *    background (a half-filled sheet was discarded), and applies once nothing
 *    is open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadOnUpdate } from './swUpdate'

class FakeSW extends EventTarget {
  controller: object | null
  constructor(controller: object | null) {
    super()
    this.controller = controller
  }
}

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function setup(controller: object | null) {
  const sw = new FakeSW(controller)
  const reload = vi.fn()
  reloadOnUpdate({ sw, doc: document, reload })
  return { sw, reload }
}

function goHidden() {
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
}

function openSheet() {
  const s = document.createElement('div')
  s.className = 'sheet'
  const input = document.createElement('input')
  s.appendChild(input)
  document.body.appendChild(s)
  return { sheet: s, input }
}

describe('reloadOnUpdate', () => {
  it('B99: the first controllerchange of a first-ever visit is not an update', () => {
    const { sw, reload } = setup(null)
    sw.dispatchEvent(new Event('controllerchange'))
    expect(reload).not.toHaveBeenCalled()
    // A later deploy still reloads.
    sw.dispatchEvent(new Event('controllerchange'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a controlled page reloads on a new worker once idle', () => {
    const { sw, reload } = setup({})
    sw.dispatchEvent(new Event('controllerchange'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('B65: going to the background with a sheet open does not reload (the entry would be lost)', () => {
    const { sw, reload } = setup({})
    const { sheet, input } = openSheet()
    input.focus()
    sw.dispatchEvent(new Event('controllerchange'))
    expect(reload).not.toHaveBeenCalled()
    goHidden()
    expect(reload).not.toHaveBeenCalled()
    // Also with nothing focused in the sheet.
    input.blur()
    goHidden()
    expect(reload).not.toHaveBeenCalled()
    // Once the sheet is gone, the next retry applies the update.
    sheet.remove()
    goHidden()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('B65: the update applies after the sheet closes and focus leaves it', () => {
    vi.useFakeTimers()
    const { sw, reload } = setup({})
    const { sheet, input } = openSheet()
    input.focus()
    sw.dispatchEvent(new Event('controllerchange'))
    sheet.remove()
    document.dispatchEvent(new FocusEvent('focusout'))
    vi.advanceTimersByTime(400)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
