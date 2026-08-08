import Link from "next/link";
import { AdminTestAlert } from "@/components/admin-test-alert";
import { pushSendConfigured } from "@/lib/push";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await requireAdmin();
  const canSendPush = pushSendConfigured();

  return (
    <main>
      <div className="results-head">
        <h1>Admin</h1>
      </div>
      <ul className="commute-list">
        <li className="commute-list-row">
          <div>
            <p className="commute-list-name">Timetable</p>
            <p className="editor-hint">Load status, upload a new timetable, sync SFTP data.</p>
          </div>
          <Link className="btn btn-secondary" href="/admin/timetable">
            Open
          </Link>
        </li>
        <li className="commute-list-row">
          <div>
            <p className="commute-list-name">Users</p>
            <p className="editor-hint">See who has an account, promote or demote admins.</p>
          </div>
          <Link className="btn btn-secondary" href="/admin/users">
            Open
          </Link>
        </li>
      </ul>

      <div className="notice">
        <h2>Push notifications</h2>
        <p>
          Send a test alert to your own device to check push is working. You need push alerts
          turned on in <Link href="/settings">Settings</Link> first.
        </p>
        <AdminTestAlert sendConfigured={canSendPush} />
      </div>
    </main>
  );
}
