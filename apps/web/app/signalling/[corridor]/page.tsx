import Link from "next/link";
import { notFound } from "next/navigation";
import { SignallingDiagram } from "@/components/signalling-diagram";
import {
  SIGNALLING_CORRIDOR_IDS,
  SIGNALLING_CORRIDORS,
  namedSignallingCorridor,
} from "@/lib/signalling-corridors";
import { getCorridorGeometry } from "@/lib/signalling";

/**
 * Every corridor renders through here — trunk and branches alike.
 *
 * The branch pages used to be a hardcoded slug→title table that said "Blueprint
 * queued" and drew nothing. Now that corridors carry their own station lists,
 * there is nothing branch-specific left: the same live component draws them all.
 */

export function generateStaticParams() {
  return SIGNALLING_CORRIDOR_IDS.map((corridor) => ({ corridor }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ corridor: string }>;
}) {
  const { corridor } = await params;
  const found = namedSignallingCorridor(corridor);
  if (!found) return { title: "Signalling · Signaller" };
  return { title: `${found.title} live signalling · Signaller` };
}

export default async function SignallingCorridorPage({
  params,
}: {
  params: Promise<{ corridor: string }>;
}) {
  const { corridor: corridorId } = await params;
  const corridor = namedSignallingCorridor(corridorId);
  if (!corridor) notFound();

  const parent = corridor.parentId ? SIGNALLING_CORRIDORS[corridor.parentId] : undefined;
  const parentStation = parent?.stations.find((s) => s.crs === corridor.parentAtCrs);

  // Static geometry, fetched once here rather than streamed with the live
  // state. Falls back to an empty shape if the database is unreachable, so a
  // Track Model outage costs real spacing but never the whole board.
  const geometry = await getCorridorGeometry(corridor.id).catch(() => ({
    stations: [],
    sections: [],
  }));

  return (
    <main className="signal-page">
      <div className="results-head">
        <h1>{corridor.title} signalling</h1>
        <span className="when">
          {parent ? (
            <>
              Branches from {parentStation?.name ?? corridor.parentAtCrs} ·{" "}
              <Link href={`/signalling/${parent.id}`}>back to {parent.shortTitle}</Link>
            </>
          ) : (
            <>
              <Link href={`/boards/${corridor.stations[0]?.crs ?? "WAT"}`}>
                {corridor.stations[0]?.name ?? "Terminus"} board
              </Link>
              {" · "}
              <Link href="/map">live map</Link>
            </>
          )}
        </span>
      </div>

      <SignallingDiagram
        query={`corridor=${corridor.id}`}
        title={corridor.shortTitle}
        mode="inline"
        variant="blueprint"
        geometry={geometry}
      />

      <section className="signal-blueprint-notes" aria-labelledby="signal-blueprint-notes-title">
        <h2 id="signal-blueprint-notes-title">Coverage</h2>
        <p>
          This live board resolves TD areas from every station on the {corridor.title}, then draws
          the SMART berth topology with live headcodes and any decoded S-class signal aspects.
        </p>
        <p>
          It is a derived operational schematic for situational awareness, not an official Network
          Rail signalling plan. Where no SOP map exists, the board still shows berth occupancy and
          marks signal aspects as unknown. Stations are spaced by real track mileage where Track
          Model data covers them, and evenly where it does not.
        </p>
      </section>
    </main>
  );
}
