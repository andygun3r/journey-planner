/**
 * Signaller's mark: three block sections of a running line, the middle one
 * occupied.
 *
 * This is the signaller's core mental model — the line divided into blocks, one
 * train per block, and the job is knowing which block is occupied. It is what
 * the app is actually about.
 *
 * It replaces the banner-repeater disc from the original brand handoff
 * (`data/design/`). That mark was faithful to a real piece of rail equipment,
 * but a circle with a 45° bar through it is also the universal negation glyph:
 * as an app icon, with no wordmark or rail context to disambiguate it, it read
 * as "no entry". The blocks carry the same idea — a signal at clear means the
 * block ahead is free — without a shape that says the opposite of what it means.
 *
 * Construction, on a 100x34 viewBox (kept identical in
 * [SignalMark.swift](apps/ios/Signaller/DesignSystem/SignalMark.swift) and
 * [generate-icon.py](apps/ios/Tools/generate-icon.py) so the mark can never
 * drift between platforms):
 *
 * - three blocks, full height, radius 4
 * - clear blocks 13 wide at x=15 and x=78; the occupied block 26 wide at x=41
 *
 * The occupied block is wider because a train occupies a section, not a point;
 * it sits slightly forward of centre so the mark reads left-to-right as travel
 * rather than as a symmetrical ornament.
 */
export function SignalMark({
  className,
  inverted = false,
  showsOccupancy = true,
}: {
  className?: string;
  /** Navy blocks for a light ground; white for a navy one. */
  inverted?: boolean;
  /** Whether the occupied block shows in Signal Red. */
  showsOccupancy?: boolean;
}) {
  const clear = inverted ? "#FFFFFF" : "var(--rail-navy)";
  const occupied = showsOccupancy ? "var(--signal-red)" : clear;

  return (
    <svg
      className={className}
      viewBox="0 0 100 34"
      role="img"
      aria-label="Signaller"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="8.5" y="0" width="13" height="34" rx="4" fill={clear} />
      <rect x="28" y="0" width="26" height="34" rx="4" fill={occupied} />
      <rect x="71.5" y="0" width="13" height="34" rx="4" fill={clear} />
    </svg>
  );
}
