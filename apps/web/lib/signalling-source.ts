import { subscribeToSource, type Unsubscribe } from "./live-source";
import {
  areaKey,
  getDiagramState,
  getLayout,
  resolveAreas,
  type DiagramState,
} from "./signalling";
import type { DiagramLayout } from "./signalling-layout";

/**
 * The shared signalling computation behind the diagram's stream.
 *
 * The diagram polled every 8 seconds and got the whole thing back each time —
 * including `layout`, which is derived entirely from SMART reference data and
 * does not change while anyone is watching. Hundreds of berth nodes were
 * re-sent 7.5 times a minute to redraw an identical picture.
 *
 * Here the layout is sent once and the live overlay is streamed. The overlay is
 * also shared: everyone looking at the same corridor gets one computation.
 *
 * Unlike the map, this has no wall-clock component — a signal that nobody
 * reports on is genuinely unchanged — so the interval is a safety net rather
 * than the main driver. The S-class and position channels do the real work.
 */

/** Slow, because events are the real trigger. This only covers a missed publish. */
const TICK_MS = Number(process.env.SIGNALLING_TICK_MS ?? 20_000);

/** Aspects flick quickly and several bits arrive together; coalesce them. */
const DEBOUNCE_MS = Number(process.env.SIGNALLING_DEBOUNCE_MS ?? 500);

export interface DiagramQuery {
  trainId?: string;
  rid?: string;
  area?: string;
  crs?: string;
  corridor?: string;
}

export interface DiagramEmission {
  /**
   * The corridor's shape. Carried on every emission but only sent to a client
   * when it actually changes — see `layoutKey`.
   */
  layout: DiagramLayout;
  /** Identifies the shape, so the route can tell "same as before" cheaply. */
  layoutKey: string;
  state: DiagramState;
}

const EMPTY_LAYOUT: DiagramLayout = {
  berths: [],
  signals: [],
  edges: [],
  width: 0,
  height: 0,
};

function keyFor(query: DiagramQuery): string {
  return `signalling:${query.area ?? ""}|${query.trainId ?? ""}|${query.rid ?? ""}|${query.crs ?? ""}|${query.corridor ?? ""}`;
}

/**
 * Areas are resolved on every run, not once at connect.
 *
 * A train crossing into the next TD area changes its corridor, and the polling
 * version picked that up because it re-resolved every time. Resolving once
 * would have left the diagram showing the corridor the train had left. The
 * layout behind it is cached per area set, so re-resolving costs one indexed
 * lookup rather than a rebuild.
 */
function computeFor(query: DiagramQuery): () => Promise<DiagramEmission> {
  return async () => {
    const { areas, focusHeadcode } = await resolveAreas(query);
    if (areas.length === 0) {
      return {
        layout: EMPTY_LAYOUT,
        layoutKey: "",
        state: {
          generatedAt: new Date().toISOString(),
          areas: [],
          signals: [],
          trains: [],
          mappedAreas: 0,
        },
      };
    }

    const layout = await getLayout(areas);
    const state = await getDiagramState(areas, layout, focusHeadcode);
    return { layout, layoutKey: areaKey(areas), state };
  };
}

/**
 * Subscribe to a corridor. `onLayout` fires when the shape changes — once on
 * connect, and again if the train moves into a different TD area. `onState`
 * fires whenever the aspects or the trains move.
 */
export function subscribeToDiagram(
  query: DiagramQuery,
  onLayout: (layout: DiagramLayout, areas: string[]) => void,
  onState: (state: DiagramState) => void,
): Unsubscribe {
  let sentLayoutKey: string | undefined;

  return subscribeToSource<DiagramEmission>(
    {
      key: keyFor(query),
      compute: computeFor(query),
      intervalMs: TICK_MS,
      // S-class aspect changes, and berth steps for the trains riding the
      // diagram. Both are published per area / per train by nr-ingest.
      patterns: ["nr:sig:*", "nr:pos:*"],
      debounceMs: DEBOUNCE_MS,
    },
    (emission) => {
      if (emission.layoutKey !== sentLayoutKey) {
        sentLayoutKey = emission.layoutKey;
        onLayout(emission.layout, emission.state.areas);
      }
      onState(emission.state);
    },
  );
}
