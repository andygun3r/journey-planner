import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { AccountSection } from "@/components/account-section";
import { AccessibilitySettings } from "@/components/accessibility-settings";
import { auth } from "@/lib/auth";
import { getUserId } from "@/lib/current-user";
import { listCommutes } from "@/lib/commutes";
import { getAccessibilityPrefs } from "@/lib/accessibility-prefs";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const userId = await getUserId();
  if (!userId) redirect("/login");
  const session = await auth.api.getSession({ headers: await headers() });
  const email = session?.user?.email;
  if (!email) redirect("/login");

  const [commutes, prefs] = await Promise.all([
    listCommutes(userId),
    getAccessibilityPrefs(userId),
  ]);

  return (
    <main>
      <div className="results-head">
        <h1>Settings</h1>
      </div>

      <AccountSection email={email} />

      <div className="notice">
        <h2>Your commute</h2>
        <p>
          {commutes.length === 0
            ? "You haven't set up a commute yet."
            : `You have ${commutes.length} commute${commutes.length === 1 ? "" : "s"} set up.`}
        </p>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
          <Link className="btn btn-secondary" href="/commute/list">
            Manage commutes
          </Link>
          <Link className="btn btn-secondary" href="/commute/edit">
            Add a commute
          </Link>
          <Link className="btn btn-secondary" href="/commute/holidays">
            Holidays
          </Link>
        </div>
      </div>

      <div className="notice">
        <h2>Accessibility</h2>
        <p>
          Options for anyone who needs them — these don&rsquo;t change the app for anyone who
          doesn&rsquo;t turn them on.
        </p>
        <AccessibilitySettings prefs={prefs} />
      </div>
    </main>
  );
}
