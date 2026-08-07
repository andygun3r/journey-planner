/**
 * Signaller's mark: a UK rail banner repeater signal — a white disc, rimmed in
 * navy, with a solid navy arm through its centre, fixed at the "off"/clear
 * angle (45°). This is the only angle it's ever shown at; the arm never
 * recolours, stretches, or thins (see DESIGN.md).
 *
 * Construction (brand handoff, data/design): arm width = 130% of disc
 * diameter, arm thickness = 13% of disc diameter, rim border = 5% of disc
 * diameter. Drawn on a 100-unit viewBox disc so it scales cleanly at any size.
 */
export function SignalMark({ className, inverted = false }: { className?: string; inverted?: boolean }) {
  const rimColor = inverted ? "#FFFFFF" : "var(--rail-navy)";
  const armColor = inverted ? "#FFFFFF" : "var(--rail-navy)";
  const discColor = inverted ? "var(--rail-navy)" : "#FFFFFF";

  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Signaller"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="50" cy="50" r="47.5" fill={discColor} stroke={rimColor} strokeWidth="5" />
      <rect
        x="-15"
        y="-3.25"
        width="130"
        height="6.5"
        fill={armColor}
        transform="translate(50 50) rotate(-45)"
      />
    </svg>
  );
}
