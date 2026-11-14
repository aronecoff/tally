import type { Part } from '../lib/copy'

/** A line from lib/copy.ts with figures in it: each figure is drawn as one. */
export function Parts({ parts }: { parts: readonly Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <strong key={i} className="num">
            {p.fig}
          </strong>
        ),
      )}
    </>
  )
}
