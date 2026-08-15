import Link from "next/link";
import { SignallingDiagram } from "@/components/signalling-diagram";
import { SIGNALLING_CORRIDORS } from "@/lib/signalling-corridors";

export const metadata = {
  title: "South West Main Line live signalling · Signaller",
};

export default function SwmlSignallingPage() {
  const corridor = SIGNALLING_CORRIDORS.swml;

  return (
    <main className="signal-page">
      <div className="results-head">
        <h1>{corridor.title} signalling</h1>
        <span className="when">
          <Link href="/boards/WAT">Waterloo board</Link>
          {" · "}
          <Link href="/map">live map</Link>
        </span>
      </div>

      <SignallingDiagram
        query="corridor=swml"
        title={corridor.shortTitle}
        mode="inline"
        variant="blueprint"
      />

      <section className="signal-blueprint-notes" aria-labelledby="signal-blueprint-notes-title">
        <h2 id="signal-blueprint-notes-title">Coverage</h2>
        <p>
          This live board resolves TD areas from every station on the South West Main Line, then
          draws the SMART berth topology with live headcodes and any decoded S-class signal aspects.
        </p>
        <p>
          It is a derived operational schematic for situational awareness, not an official Network
          Rail signalling plan. Where no SOP map exists, the board still shows berth occupancy and
          marks signal aspects as unknown.
        </p>
      </section>
    </main>
  );
}
