import Link from "next/link";
import { HolidayManager } from "@/components/holiday-manager";
import { requireDevice } from "@/lib/device";
import { listHolidays } from "@/lib/holidays";

export const dynamic = "force-dynamic";

export default async function HolidaysPage() {
  const deviceId = await requireDevice();
  const holidays = await listHolidays(deviceId);

  return (
    <main className="commute-page">
      <div className="results-head">
        <h1>Holidays</h1>
        <span className="when">
          <Link href="/commute">back to dashboard</Link>
        </span>
      </div>
      <p className="editor-hint">
        Add days you&rsquo;re not commuting. We&rsquo;ll pause disruption alerts for those dates.
      </p>
      <HolidayManager holidays={holidays} />
    </main>
  );
}
