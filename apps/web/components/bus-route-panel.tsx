"use client";

/**
 * Live map's "click a bus" panel: the line's route (drawn on the map by
 * live-map.tsx as a dashed purple line, from the same fetch this panel's
 * data comes from) plus the full ordered stop list for that direction.
 */

interface BusRoute {
  lineId: string;
  lineName: string;
  direction: string;
  polylines: [number, number][][];
  stops: { naptanId: string; name: string; lat: number; lon: number }[];
}

export function BusRoutePanel({
  lineName,
  direction,
  route,
  onClose,
}: {
  lineName: string;
  direction: string;
  route: BusRoute | null;
  onClose: () => void;
}) {
  return (
    <aside className="map-panel" aria-label="Bus route">
      <div className="map-panel-head">
        <div className="map-panel-title">
          <span className="map-panel-code">Route {lineName}</span>
          <span className="map-panel-route-direction">{direction}</span>
        </div>
        <button type="button" className="map-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {!route ? (
        <p className="map-panel-empty">Loading route…</p>
      ) : route.stops.length === 0 ? (
        <p className="map-panel-empty">No route detail available for this bus.</p>
      ) : (
        <ol className="map-panel-route-stops">
          {route.stops.map((s, i) => (
            <li key={`${s.naptanId}-${i}`} className="map-panel-route-stop">
              <span className="map-panel-route-stop-marker" aria-hidden="true" />
              <span className="map-panel-route-stop-name">{s.name}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
