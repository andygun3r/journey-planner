import Link from "next/link";
import { redirect } from "next/navigation";
import { londonDate } from "@signaller/shared";
import { CommuteCalendar } from "@/components/commute-calendar";
import { CommuteSwitcher } from "@/components/commute-switcher";
import { listOverrides } from "@/lib/commute-overrides";
import { listCommutes } from "@/lib/commutes";
import { getUserId } from "@/lib/current-user";
import { holidayRangesFor } from "@/lib/holidays";

export const dynamic = "force-dynamic";

/**
 * How far either side of today the calendar loads overrides and holidays for.
 * The grid only ever shows one month, but the user can page through them, and
 * a year of a single commute's exceptions is a trivially small result — far
 * cheaper than a query per month change.
 */
const WINDOW_DAYS = 365;

/** Expands inclusive holiday ranges into the individual dates the grid marks. */
function expandHolidays(
  ranges: { startDate: string; endDate: string }[],
  from: string,
  to: string,
): string[] {
  const dates: string[] = [];
  for (const r of ranges) {
    // Clamp to the loaded window: an open-ended or very long range shouldn't
    // expand into tens of thousands of strings.
    const start = r.startDate < from ? from : r.startDate;
    const end = r.endDate > to ? to : r.endDate;
    if (start > end) continue;
    for (let d = new Date(`${start}T12:00:00Z`); ; d = new Date(d.getTime() + 86_400_000)) {
      const ymd = d.toISOString().slice(0, 10);
      if (ymd > end) break;
      dates.push(ymd);
    }
  }
  return dates;
}

interface Props {
  searchParams: Promise<{ commute?: string }>;
}

export default async function CommuteCalendarPage({ searchParams }: Props) {
  const userId = await getUserId();
  if (!userId) redirect("/login");
  const { commute: commuteParam } = await searchParams;

  const commutes = await listCommutes(userId);
  if (commutes.length === 0) {
    return (
      <main className="commute-page">
        <div className="results-head">
          <h1>Commute calendar</h1>
          <span className="when">
            <Link href="/commute">back to dashboard</Link>
          </span>
        </div>
        <div className="notice">
          <h2>No commute yet</h2>
          <p>
            <Link className="btn btn-primary" href="/commute/edit">
              Create a commute
            </Link>{" "}
            first, then you can adjust individual days here.
          </p>
        </div>
      </main>
    );
  }

  const active = commutes.find((c) => c.id === commuteParam) ?? commutes[0]!;
  const today = londonDate(new Date());
  const from = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  const [overrides, holidayRanges] = await Promise.all([
    listOverrides(userId, active.id, from, to),
    holidayRangesFor(userId),
  ]);

  return (
    <main className="commute-page">
      <div className="results-head">
        <h1>{active.label}</h1>
        <span className="when">
          <Link href="/commute">dashboard</Link> · <Link href="/commute/edit">edit weekly</Link> ·{" "}
          <Link href="/commute/holidays">holidays</Link>
        </span>
      </div>

      <CommuteSwitcher
        activeId={active.id}
        activeLabel={active.label}
        otherCommutes={commutes.filter((c) => c.id !== active.id).map((c) => ({ id: c.id, label: c.label }))}
      />

      <p className="editor-hint">
        Your usual week is the starting point — tap any day to change just that date, or every
        one of that weekday from then on. Edited days are marked.
      </p>

      <CommuteCalendar
        commuteId={active.id}
        legs={active.legs}
        overrides={overrides}
        holidayDates={expandHolidays(holidayRanges, from, to)}
        today={today}
      />
    </main>
  );
}
