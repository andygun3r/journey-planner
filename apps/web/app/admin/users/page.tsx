import { AdminUserList } from "@/components/admin-user-list";
import { requireAdmin } from "@/lib/require-admin";
import { listUsers } from "@/lib/admin-users";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const admin = await requireAdmin();
  const users = await listUsers();

  return (
    <main>
      <div className="results-head">
        <h1>Users</h1>
      </div>
      {users.length === 0 ? (
        <div className="notice">
          <p>No users yet.</p>
        </div>
      ) : (
        <AdminUserList users={users} currentUserId={admin.id} />
      )}
    </main>
  );
}
