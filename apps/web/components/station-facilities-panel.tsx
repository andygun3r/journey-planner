import { type StationFacility } from "@/lib/stations";

/** One amenity chip: "Yes"/"No" only shown for facts the feed actually reported. */
function AmenityChip({ label, has }: { label: string; has: boolean | null }) {
  if (has === null) return null;
  return <span className={`chip ${has ? "chip-ok" : "chip-muted"}`}>{has ? label : `No ${label.toLowerCase()}`}</span>;
}

/**
 * Station facilities/accessibility, from the RDG Knowledgebase feed
 * (services/etl's nightly kb-facilities sync — see apps/web/lib/stations.ts).
 * Renders nothing when there's no row: either KB isn't configured, or this
 * CRS isn't in the feed yet — never blocks the board it sits on.
 */
export function StationFacilitiesPanel({ facility }: { facility: StationFacility | null }) {
  if (!facility) return null;

  const hasAnyAmenity = [
    facility.stepFreeAccess,
    facility.hasCarPark,
    facility.hasToilets,
    facility.hasLifts,
    facility.hasWaitingRoom,
    facility.hasWifi,
    facility.assistanceAvailable,
  ].some((v) => v !== null);
  if (!hasAnyAmenity && !facility.ticketOfficeHours) return null;

  return (
    <details className="disruption station-facilities">
      <summary className="disruption-summary">
        <span className="disruption-icon" aria-hidden="true">
          ℹ
        </span>
        <span className="disruption-head">
          <span className="disruption-title">Station facilities</span>
        </span>
      </summary>
      <div className="disruption-body">
        <div className="station-facilities-chips">
          <AmenityChip label="Step-free access" has={facility.stepFreeAccess} />
          <AmenityChip label="Car park" has={facility.hasCarPark} />
          <AmenityChip label="Toilets" has={facility.hasToilets} />
          <AmenityChip label="Lifts" has={facility.hasLifts} />
          <AmenityChip label="Waiting room" has={facility.hasWaitingRoom} />
          <AmenityChip label="Wi-Fi" has={facility.hasWifi} />
          <AmenityChip label="Staff assistance" has={facility.assistanceAvailable} />
        </div>
        {facility.stepFreeDescription && (
          <p className="disruption-block">{facility.stepFreeDescription}</p>
        )}
        {facility.ticketOfficeHours && (
          <p className="disruption-block">Ticket office: {facility.ticketOfficeHours}</p>
        )}
        {facility.carParkSpaces != null && (
          <p className="disruption-block">Car parking: {facility.carParkSpaces} spaces</p>
        )}
        {facility.assistanceDescription && (
          <p className="disruption-block">{facility.assistanceDescription}</p>
        )}
      </div>
    </details>
  );
}
