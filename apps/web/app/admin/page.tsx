import Link from "next/link";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await requireAdmin();

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
    </main>
  );
}
