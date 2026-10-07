import { use } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

/**
 * A live query for one key (a month) that never hands back another key's rows.
 *
 * useLiveQuery keeps returning the previous result after its deps change,
 * until the new query answers. Stepping months therefore committed the new
 * month's label (App state) over the old month's figures for a frame or more.
 * Here a key change on a mounted screen suspends instead: MonthSwitch steps
 * inside a transition, so React keeps the old label and the old figures on
 * screen together and swaps both in one commit once the new rows are in.
 *
 * The first load (a screen mounting) still returns undefined, so the caller
 * shows its own skeleton as before.
 *
 * The new key's rows are read once per step, into a load filed under the
 * answer the live query held when the step began. Every answer of a live
 * query is a new object, and each screen has its own, so a load serves only
 * the step that made it: the retry render after the suspend, and any render
 * before the live query answers for the new key. Once it answers, the old
 * answer is replaced and its loads can no longer be found (the WeakMap lets
 * them go). Coming back to a month later therefore always reads it again,
 * never an earlier visit's rows that an edit or a sync has since changed.
 *
 * A failed load is not dropped early. React must find it again on the retry
 * to throw its error to RootBoundary; a fresh read in its place would suspend
 * once more, and a failure that persists would then loop reads behind the
 * skeleton instead of reaching the boundary. It cannot outlive the boundary's
 * recovery either: the remount starts a new live query, so no later step can
 * find it.
 */

type Answer<T> = { key: string; value: T }

const loads = new WeakMap<object, Map<string, Promise<unknown>>>()

function load<T>(from: object, key: string, querier: () => Promise<T> | T): Promise<T> {
  let byKey = loads.get(from)
  if (!byKey) {
    byKey = new Map()
    loads.set(from, byKey)
  }
  const cached = byKey.get(key) as Promise<T> | undefined
  if (cached) return cached
  const p = new Promise<T>((resolve) => resolve(querier()))
  // A step that was overtaken (a second tap) never reads its load; keep its
  // failure from surfacing as an unhandled rejection.
  p.catch(() => {})
  byKey.set(key, p)
  return p
}

export function useKeyedLiveQuery<T>(key: string, querier: () => Promise<T> | T): T | undefined {
  const live: Answer<T> | undefined = useLiveQuery(async () => ({ key, value: await querier() }), [key])
  if (live === undefined) return undefined
  if (live.key === key) return live.value
  return use(load(live, key, querier))
}
