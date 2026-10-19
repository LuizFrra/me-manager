/** The tree's expand arrow: points right, turned down by CSS while `open`. */
export function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      className={`chevron${open ? ' open' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** The app's mark: a terracotta spark of twelve rounded rays, in the spirit of Claude's. */
export function Spark({ size = 18 }: { size?: number }): React.JSX.Element {
  const rays = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg className="spark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {rays.map((deg, i) => (
        <line
          key={deg}
          x1="12"
          y1="12"
          x2="12"
          y2={i % 2 === 0 ? 1.5 : 4}
          transform={`rotate(${deg} 12 12)`}
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      ))}
    </svg>
  )
}
