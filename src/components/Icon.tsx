import { PATHS, UI_PATHS } from './iconPaths'

interface Props {
  name: string
  size?: number
  className?: string
}

export function Icon({ name, size = 20, className }: Props) {
  const d = PATHS[name] ?? UI_PATHS[name] ?? PATHS.tag
  // Optically sized stroke: about 1.35px on screen at every size (clamped).
  const sw = Math.max(1.5, Math.min(2.2, 32.4 / size))
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}
