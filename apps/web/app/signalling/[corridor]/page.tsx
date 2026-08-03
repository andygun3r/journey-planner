import Link from "next/link";
import { notFound } from "next/navigation";

const BRANCH_CORRIDORS: Record<string, { title: string; via: string }> = {
  "windsor": { title: "Windsor lines signalling", via: "Clapham Junction" },
  "windsor-reading": { title: "Windsor and Reading lines signalling", via: "Clapham Junction" },
  "epsom": { title: "Epsom line signalling", via: "Raynes Park" },
  "chessington": { title: "Chessington branch signalling", via: "Raynes Park" },
  "kingston-shepperton": { title: "Kingston loop and Shepperton signalling", via: "New Malden" },
  "hampton-court": { title: "Hampton Court branch signalling", via: "Surbiton" },
  "guildford-cobham": { title: "Guildford via Cobham signalling", via: "Surbiton" },
  "chertsey": { title: "Chertsey and Staines branch signalling", via: "Weybridge" },
  "portsmouth-direct": { title: "Portsmouth Direct signalling", via: "Woking" },
  "alton-ascot": { title: "Alton and Ascot lines signalling", via: "Brookwood" },
  "west-of-england": { title: "West of England signalling", via: "Basingstoke" },
  "reading-basingstoke": { title: "Reading and Berks & Hants signalling", via: "Basingstoke" },
  "fareham": { title: "Portsmouth via Fareham signalling", via: "Eastleigh" },
  "romsey-netley": { title: "Romsey and Netley lines signalling", via: "Eastleigh" },
  "lymington": { title: "Lymington branch signalling", via: "Brockenhurst" },
};

export default async function SignallingBranchPage({
  params,
}: {
  params: Promise<{ corridor: string }>;
}) {
  const { corridor } = await params;
  const branch = BRANCH_CORRIDORS[corridor];
  if (!branch) notFound();

  return (
    <main className="signal-page signal-branch-page">
      <div className="results-head">
        <h1>{branch.title}</h1>
        <span className="when">
          Branches from {branch.via} · <Link href="/signalling/swml">back to SWML</Link>
        </span>
      </div>

      <section className="signal-blueprint-notes" aria-labelledby="signal-branch-title">
        <h2 id="signal-branch-title">Blueprint queued</h2>
        <p>
          This branch link is wired from the SWML signal map. The next step is to define this
          corridor's station list and TD-area resolver, then render it with the same live blueprint
          component.
        </p>
      </section>
    </main>
  );
}
