import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagramState } from "./signalling";
import type { DiagramLayout } from "./signalling-layout";

/**
 * The point of the split is that the corridor's shape is sent once and the live
 * overlay is sent every time. Drive the shared source's callback directly and
 * check exactly that.
 */

type Emit = (emission: unknown) => void;
let emit: Emit | undefined;

vi.mock("./live-source", () => ({
  subscribeToSource: (_options: unknown, onSnapshot: Emit) => {
    emit = onSnapshot;
    return () => {
      emit = undefined;
    };
  },
}));
vi.mock("./signalling", () => ({
  resolveAreas: vi.fn(),
  getLayout: vi.fn(),
  getDiagramState: vi.fn(),
  areaKey: (areas: string[]) => [...areas].sort().join(","),
}));

const { subscribeToDiagram } = await import("./signalling-source");

function layout(berths: number): DiagramLayout {
  return {
    berths: Array.from({ length: berths }, (_, i) => ({
      id: `X1:B${i}`,
      tdArea: "X1",
      berth: `B${i}`,
      x: i * 10,
      y: 0,
    })),
    signals: [],
    edges: [],
    width: berths * 10,
    height: 30,
  };
}

function state(areas: string[]): DiagramState {
  return {
    generatedAt: "2026-07-30T12:00:00.000Z",
    areas,
    signals: [],
    trains: [],
    mappedAreas: 0,
  };
}

beforeEach(() => {
  emit = undefined;
});

describe("subscribeToDiagram", () => {
  it("sends the corridor's shape once, and the overlay every time", () => {
    const onLayout = vi.fn();
    const onState = vi.fn();
    subscribeToDiagram({ area: "X1" }, onLayout, onState);

    const emission = { layout: layout(8), layoutKey: "X1", state: state(["X1"]) };
    emit?.(emission);
    emit?.(emission);
    emit?.(emission);

    expect(onLayout).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledTimes(3);
  });

  // A train crossing into the next TD area really is a different corridor, and
  // the polling version picked that up because it re-resolved every time.
  it("sends a new shape when the train moves into another TD area", () => {
    const onLayout = vi.fn();
    const onState = vi.fn();
    subscribeToDiagram({ trainId: "T1" }, onLayout, onState);

    emit?.({ layout: layout(8), layoutKey: "X1", state: state(["X1"]) });
    emit?.({ layout: layout(8), layoutKey: "X1", state: state(["X1"]) });
    emit?.({ layout: layout(12), layoutKey: "X2", state: state(["X2"]) });

    expect(onLayout).toHaveBeenCalledTimes(2);
    expect(onLayout.mock.calls[1]?.[1]).toEqual(["X2"]);
    expect(onState).toHaveBeenCalledTimes(3);
  });

  it("gives each subscriber its own idea of what it has already been sent", () => {
    const first = vi.fn();
    subscribeToDiagram({ area: "X1" }, first, vi.fn());
    emit?.({ layout: layout(8), layoutKey: "X1", state: state(["X1"]) });
    expect(first).toHaveBeenCalledTimes(1);

    // A viewer joining an established corridor still needs the shape.
    const second = vi.fn();
    subscribeToDiagram({ area: "X1" }, second, vi.fn());
    emit?.({ layout: layout(8), layoutKey: "X1", state: state(["X1"]) });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
