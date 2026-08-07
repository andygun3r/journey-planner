import Link from "next/link";
import { redirect } from "next/navigation";
import { listCommutes } from "@/lib/commutes";
import { getUserId } from "@/lib/current-user";

export const dynamic = "force-dynamic";

const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function CommuteListPage() {
  const userId = await getUserId();
  if (!userId) redirect("/login");
  const commutes = await listCommutes(userId);

  return (
    <main className="commute-page">
      <div className="results-head">
        <h1>Your commutes</h1>
        <span className="when">
          <Link href="/commute">back to dashboard</Link>
        </span>
      </div>

      {commutes.length === 0 ? (
        <div className="notice">
          <h2>No commutes yet</h2>
          <p>Add one for your daily journey to work, and any others you travel regularly.</p>
        </div>
      ) : (
        <ul className="commute-list">
          {commutes
            .slice()
            .sort((a, b) => b.priority - a.priority)
            .map((c) => (
              <li key={c.id} className="commute-list-row">
                <div>
                  <p className="commute-list-name">{c.label}</p>
                  <p className="editor-hint">
                    {c.homeLabel ?? "Home"} ·{" "}
                    {c.legs.length === 0
                      ? "No days set"
                      : c.legs
                          .map((l) => DAY_SHORT[l.dayOfWeek])
                          .join(", ")}
                  </p>
                </div>
                <Link className="btn btn-secondary" href={`/commute/edit/${c.id}`}>
                  Edit
                </Link>
              </li>
            ))}
        </ul>
      )}

      <p>
        <Link className="btn btn-primary" href="/commute/edit">
          Add a commute
        </Link>
      </p>
    </main>
  );
}
