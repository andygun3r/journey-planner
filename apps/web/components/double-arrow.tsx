/**
 * The British Rail "double arrow" symbol (Gerald Barney, 1965), re-tinted as
 * Mainline's duotone mark: the upper (right-pointing) arrow in Rail Blue, the
 * lower (left-pointing) arrow in Rail Red — the one place the two brand
 * colours literally join. Geometry verified to render as the recognizable mark.
 */
export function DoubleArrow({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 22"
      role="img"
      aria-label="Mainline double arrow"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Upper arrow — points right, Rail Blue */}
      <path fill="var(--primary)" d="M0 3 L44 3 L44 1 L62 5 L44 9 L44 7 L0 7 Z" />
      {/* Lower arrow — points left, Rail Red (upper rotated 180°) */}
      <path fill="var(--accent)" d="M64 19 L20 19 L20 21 L2 17 L20 13 L20 15 L64 15 Z" />
    </svg>
  );
}
