import { getLiveTrains } from "./live-trains";
import { subscribeToSource, type Unsubscribe } from "./live-source";
import { toMapTrain, type MapTrain } from "@/components/map-types";

/**
 * The shared live position for one service.
 *
 * The service page ran three uncoordinated timers for a single train: a 30s
 * page refresh, a 25s position poll, and an 8s signalling poll. The position
 * poll was the worst of them — it re-downloaded the train's whole calling
 * pattern *and* its track-following route geometry every 25 seconds to redraw a
 * line that had not moved.
 *
 * Here the route is fetched once by the client and only the position is
 * streamed. As with the map, the tick is a floor rather than a fallback: a
 * departed train slides along its leg from Date.now(), so it moves on screen
 * even when nothing new has been reported.
 */

const TICK_MS = Number(process.env.SERVICE_TICK_MS ?? 10_000);
const DEBOUNCE_MS = Number(process.env.SERVICE_DEBOUNCE_MS ?? 750);

/** Null when the service is not currently correlated to a moving train. */
export type ServicePosition = MapTrain | null;

export function subscribeToService(
  rid: string,
  onPosition: (position: ServicePosition) => void,
): Unsubscribe {
  return subscribeToSource<ServicePosition>(
    {
      key: `service:${rid}`,
      compute: async () => {
        const result = await getLiveTrains(1, rid);
        const train = result.trains[0];
        return train ? toMapTrain(train) : null;
      },
      intervalMs: TICK_MS,
      // Position reports for any train — the cheap filter is on the compute,
      // which reads one row — plus this service's own Darwin updates, which is
      // what changes its lateness.
      patterns: ["nr:pos:*"],
      channels: [`darwin:rid:${rid}`],
      debounceMs: DEBOUNCE_MS,
    },
    onPosition,
  );
}
