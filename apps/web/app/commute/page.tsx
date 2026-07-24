import Link from "next/link";
import { listCommutes } from "@/lib/commutes";
import { requireDevice } from "@/lib/device";

export const dynamic = "force-dynamic";

// NOTE: interim dashboard — the smart "next departure" focus + alert feed land
// in a later step. For now this lists the user's commutes and links to editing.

export default async function CommuteDashboardPage() {
  const deviceId = await requireDevice();
  const commutes = await listCommutes(deviceId);

  return (
    <main className="commute-page">
      <div className="results-head">
        <h1>My commute</h1>
        <span className="when">
          <Link href="/commute/holidays">holidays</Link> · <Link href="/commute/edit">add commute</Link>
        </span>
      </div>

      {commutes.length === 0 ? (
        <div className="notice">
          <h2>Set up your commute</h2>
          <p>
            Tell Mainline your weekly schedule — where you travel each day and roughly when — and
            we&rsquo;ll watch your usual trains and warn you when they&rsquo;re disrupted.
          </p>
          <p>
            <Link className="btn btn-primary" href="/commute/edit">
              Create a commute
            </Link>
          </p>
        </div>
      ) : (
        <ul className="commute-cards">
          {commutes.map((c) => (
            <li key={c.id} className="commute-card">
              <div className="commute-card-head">
                <h2>{c.label}</h2>
                <Link href={`/commute/edit/${c.id}`}>edit</Link>
              </div>
              <p className="commute-card-home">
                {c.homeLabel ?? "Home"} · {c.homeCrs}
              </p>
              <p className="commute-card-days">
                {c.legs.length} day{c.legs.length === 1 ? "" : "s"} a week
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
