import { Component, Fragment, type ReactNode } from 'react'
import Dexie from 'dexie'
import { db } from '../db/db'

/** Reopens before giving up and offering Reload. */
const MAX_TRIES = 3
/** Healthy this long after a recovery: a later failure gets fresh tries. */
const HEALTHY_MS = 30_000
/** A reopen that never answers falls back to Reload. */
const OPEN_TIMEOUT_MS = 4000

/** What IndexedDB throws when the connection drops (WebKit: 'Connection to
 *  Indexed Database server lost' is an UnknownError). */
const DB_ERROR_NAMES = new Set(['UnknownError', 'InvalidStateError', 'DatabaseClosedError'])

function isDbError(e: unknown): boolean {
  return e instanceof Dexie.DexieError || (e instanceof Error && DB_ERROR_NAMES.has(e.name))
}

interface Props {
  children: ReactNode
  /** Injected for tests; defaults to location.reload(). */
  reload?: () => void
}

interface State {
  error: unknown
  /** Remount key: a recovery mounts the app afresh. */
  key: number
  tries: number
  gaveUp: boolean
}

/**
 * The app's last line. A live query that fails rethrows during render, and
 * with nothing to catch it React unmounted the whole app: an empty page with
 * no way back short of a relaunch. A lost database connection is reopened and
 * the app remounted (the month lives in sessionStorage and the tab in the
 * hash; only an open sheet's unsaved input is lost), up to three times in a
 * row. Anything else, or a connection that will not come back, offers Reload.
 */
export class RootBoundary extends Component<Props, State> {
  state: State = { error: null, key: 0, tries: 0, gaveUp: false }
  private healthy: number | undefined
  private openTimer: number | undefined

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error }
  }

  private retrying(): boolean {
    const { error, tries, gaveUp } = this.state
    return isDbError(error) && tries < MAX_TRIES && !gaveUp
  }

  componentDidCatch(error: unknown) {
    window.clearTimeout(this.healthy)
    if (!isDbError(error) || this.state.tries >= MAX_TRIES || this.state.gaveUp) return
    // Never a bare close(): in Dexie 4 it turns autoOpen off, and if the reopen
    // then failed every live query would sit on DatabaseClosedError, which
    // liveQuery swallows, so the app would hang on skeletons with no error.
    db.close({ disableAutoOpen: false })
    const giveUp = () => {
      window.clearTimeout(this.openTimer)
      this.setState({ gaveUp: true })
    }
    this.openTimer = window.setTimeout(giveUp, OPEN_TIMEOUT_MS)
    db.open().then(() => {
      window.clearTimeout(this.openTimer)
      this.setState((s) => (s.gaveUp ? null : { error: null, key: s.key + 1, tries: s.tries + 1 }))
    }, giveUp)
  }

  componentDidUpdate(_: Props, prev: State) {
    if (prev.error != null && this.state.error == null && this.state.tries > 0) {
      window.clearTimeout(this.healthy)
      this.healthy = window.setTimeout(() => this.setState({ tries: 0 }), HEALTHY_MS)
    }
  }

  componentWillUnmount() {
    window.clearTimeout(this.healthy)
    window.clearTimeout(this.openTimer)
  }

  render() {
    if (this.state.error == null) return <Fragment key={this.state.key}>{this.props.children}</Fragment>
    // Reopening takes a moment: nothing rather than a flash of the fallback.
    if (this.retrying()) return null
    const reload = this.props.reload ?? (() => window.location.reload())
    return (
      <div className="empty" role="alert">
        <p>Tally could not read its data on this device.</p>
        <button type="button" className="detail-toggle" onClick={reload}>
          Reload
        </button>
      </div>
    )
  }
}
