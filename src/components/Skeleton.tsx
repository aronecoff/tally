import type { CSSProperties } from 'react'

export type SkeletonVariant = 'home' | 'budget' | 'insights' | 'accounts' | 'list'

interface Props {
  variant: SkeletonVariant
}

const bar = (width: string | number, height: string | number, extra?: CSSProperties): CSSProperties => ({
  width,
  height,
  ...extra,
})

function Hero({ rail }: { rail?: boolean }) {
  return (
    <div className="skel-hero">
      <span className="skel" style={bar(96, 11)} />
      <span className="skel" style={bar(120, 15, { marginTop: 4 })} />
      <span className="skel" style={bar(196, 46)} />
      <span className="skel" style={bar(220, 13)} />
      {rail && <span className="skel" style={bar('100%', 3, { marginTop: 12 })} />}
    </div>
  )
}

function Rows({ n }: { n: number }) {
  return (
    <div>
      {Array.from({ length: n }, (_, i) => (
        <div className="skel-row" key={i}>
          <span className="skel" style={bar(20, 20)} />
          <span className="skel-lines">
            <span className="skel" style={bar(`${58 - ((i * 7) % 20)}%`, 13)} />
            <span className="skel" style={bar(`${40 - ((i * 5) % 14)}%`, 11)} />
          </span>
          <span className="skel" style={bar(64, 13)} />
        </div>
      ))}
    </div>
  )
}

/**
 * Loading placeholder shaped like the screen it stands in for. Shown while
 * live queries are still undefined, so no screen ever flashes a false empty
 * state or $0.00. Pulses only when motion is allowed.
 */
export function Skeleton({ variant }: Props) {
  return (
    <div className="skel-wrap" aria-busy="true" aria-live="polite" aria-label="Loading">
      {variant === 'list' ? (
        <Rows n={6} />
      ) : (
        <>
          <Hero rail={variant === 'home' || variant === 'budget'} />
          {variant === 'insights' && <span className="skel" style={bar('100%', 132, { marginBottom: 24 })} />}
          {variant === 'accounts' && (
            <span className="skel" style={bar('100%', 'auto', { aspectRatio: '100 / 64', marginBottom: 24 })} />
          )}
          <Rows n={variant === 'budget' ? 5 : variant === 'accounts' ? 4 : 3} />
        </>
      )}
    </div>
  )
}
