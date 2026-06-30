/**
 * Minimal 24×24 line-icon set, stroke = currentColor. Categories store an icon
 * `key` (see db.ts); custom categories fall back to `tag`. Keeping these inline
 * avoids an icon-library dependency and keeps the PWA fully offline.
 */
const PATHS: Record<string, string> = {
  cart: 'M2.5 3.5h2l2.4 11.2a1.7 1.7 0 0 0 1.7 1.3h8a1.7 1.7 0 0 0 1.7-1.3L20 7H6 M9 20.5h.01 M17 20.5h.01',
  utensils: 'M4 3v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3 M6 11v10 M16.5 3c-1.4 0-2.5 2-2.5 4.5S15 12 16.5 12V21',
  home: 'M3 10.5 12 3l9 7.5 M5.5 9v11.5h13V9',
  car: 'M4.5 13 6 8.2A2 2 0 0 1 7.9 7h8.2a2 2 0 0 1 1.9 1.2L19.5 13 M4 13h16v5.5H4z M8 18.5h.01 M16 18.5h.01',
  repeat: 'M17 2.5 21 6l-4 3.5 M21 6H7a4 4 0 0 0-4 4v1 M7 21.5 3 18l4-3.5 M3 18h14a4 4 0 0 0 4-4v-1',
  heart: 'M12 20.5C8 17.5 3.5 13.8 3.5 9.5A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 8.5 2.5c0 4.3-4.5 8-8.5 11z',
  bag: 'M5.5 8h13l1 12.5h-15zM9 8V6a3 3 0 0 1 6 0v2',
  sparkles: 'M12 3l1.7 4.6L18.5 9.5l-4.8 1.9L12 16l-1.7-4.6L5.5 9.5l4.8-1.9zM18.5 16l.7 1.9 2 .8-2 .8-.7 1.9-.7-1.9-2-.8 2-.8z',
  box: 'M21 8 12 3 3 8l9 5 9-5z M3 8v8l9 5 9-5V8 M12 13v8',
  briefcase: 'M4 7.5h16v12H4z M8.5 7.5V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2 M4 12.5h16',
  receipt: 'M6 2.5h12v19l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3zM9 7.5h6 M9 11.5h6 M9 15.5h4',
  'plus-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 8v8 M8 12h8',
  tag: 'M3.5 3.5H10l10.5 10.5-6.5 6.5L3.5 10zM7.5 7.5h.01',
  // Navigation
  pie: 'M21 12a9 9 0 1 1-9-9v9z M21 11.5A9 9 0 0 0 12.5 3v8.5z',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3.5 6h.01 M3.5 12h.01 M3.5 18h.01',
  download: 'M12 3v12 M7.5 11l4.5 4.5 4.5-4.5 M4 20.5h16',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
  sun: 'M12 8a4 4 0 1 0 .01 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.4 1.4 M17.6 17.6 19 19 M19 5l-1.4 1.4 M6.4 17.6 5 19',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z',
  plus: 'M12 5v14 M5 12h14',
  cloud: 'M17.5 18.5a3.75 3.75 0 0 0 .4-7.48 5.25 5.25 0 0 0-10.1-1.1A4.25 4.25 0 0 0 7.2 18.5z',
  check: 'M4 12.5 9 17.5 20 6.5',
  wallet: 'M4 7.5h13a1 1 0 0 1 1 1V10 M3 6.5v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2 2 2 0 0 1 2-2h12 M17.5 14h.01',
  card: 'M3.5 6.5h17a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z M2.5 10.5h19 M6 14.5h4',
  chart: 'M3.5 21h17 M6.5 21V11 M11.5 21V5 M16.5 21v-8',
  bank: 'M3.5 10 12 4.5 20.5 10 M4.5 10v8 M9.5 10v8 M14.5 10v8 M19.5 10v8 M3 21h18',
}

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

/** The pickable icon keys, in display order (used by the category editor). */
export const ICON_KEYS = Object.keys(PATHS)
