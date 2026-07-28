import { PATHS } from './iconPaths'

interface Props {
  name: string
  size?: number
  className?: string
}

export function Icon({ name, size = 20, className }: Props) {
  const d = PATHS[name] ?? PATHS.tag
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d.split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  )
}
