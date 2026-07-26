"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { H, W, type Projection } from "../lib/map-projection";
import { MapCanvas } from "./map-canvas";
import type { LiveTrain, LiveTrainsResult } from "./map-types";

/**
 * The service-detail page's "current position" view: MapCanvas reused exactly
 * as-is, fed a single-train dataset (this rid only) and a projection cropped
 * to that train's own corridor rather than the whole-GB projection the live
 * map uses — otherwise a lone dot would sit lost in a country-sized canvas.
 * Polls less aggressively than the full map since one train's position is
 * less time-critical to refresh. MapCanvas's SVG viewBox is fixed to the
 * shared W/H constants, so the corridor projection must output into that
 * same coordinate space, not an independent one.
 */

const POLL_MS = 25_000;
const PAD = 0.08; // fraction of span, so endpoints don't sit on the edge

function corridorProjection(train: LiveTrain): Projection {
  const points = train.path?.length ? train.path : [{ lat: train.lat, lon: train.lon }];
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLon = Math.min(...lons);
  let maxLon = Math.max(...lons);
  // Guard degenerate (single-point or dead-straight) corridors.
  if (maxLat - minLat < 0.01) {
    minLat -= 0.05;
    maxLat += 0.05;
  }
  if (maxLon - minLon < 0.01) {
    minLon -= 0.05;
    maxLon += 0.05;
  }
  const latPad = (maxLat - minLat) * PAD;
  const lonPad = (maxLon - minLon) * PAD;
  minLat -= latPad;
  maxLat += latPad;
  minLon -= lonPad;
  maxLon += lonPad;

  return (lat: number, lon: number) => ({
    x: ((lon - minLon) / (maxLon - minLon)) * W,
    y: ((maxLat - lat) / (maxLat - minLat)) * H,
  });
}

export function ServicePositionMap({ rid }: { rid: string }) {
  const [data, setData] = useState<LiveTrainsResult | null>(null);
  const [error, setError] = useState(false);

  const fetchTrain = useCallback(async () => {
    try {
      const res = await fetch(`/api/live-trains?rid=${encodeURIComponent(rid)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("bad");
      setData((await res.json()) as LiveTrainsResult);
      setError(false);
    } catch {
      setError(true);
    }
  }, [rid]);

  useEffect(() => {
    fetchTrain();
    const id = setInterval(fetchTrain, POLL_MS);
    return () => clearInterval(id);
  }, [fetchTrain]);

  const train = data?.trains[0];
  const project = useMemo(() => (train ? corridorProjection(train) : null), [train]);
  const stations = useMemo<Array<[number, number]>>(
    () => train?.path?.map((p) => [p.lat, p.lon] as [number, number]) ?? [],
    [train],
  );

  if (error) return null; // honest uncertainty: no map rather than a broken one
  if (!data) return <p className="notice-muted">Loading live position…</p>;
  if (!train || !project) return null; // not currently correlated — text banner above still covers it

  return (
    <div className="service-position-map">
      <MapCanvas
        stations={stations}
        trains={[train]}
        project={project}
        selectedId={null}
        onSelect={() => {}}
      />
    </div>
  );
}
