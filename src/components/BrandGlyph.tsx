/** The app icon's tally mark: four strokes and the accent diagonal. */
export function BrandGlyph() {
  return (
    <svg
      className="head-glyph"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M7 5.75v12.5 M10.33 5.75v12.5 M13.67 5.75v12.5 M17 5.75v12.5" />
      <path className="head-glyph-slash" d="M7 17.2 17 6.8" />
    </svg>
  )
}
