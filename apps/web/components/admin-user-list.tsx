"use client";

import { useState, useTransition } from "react";
import { setUserRoleAction } from "@/app/admin/actions";
import type { AdminUserRecord } from "@/lib/admin-users";

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

interface Props {
  users: AdminUserRecord[];
  currentUserId: string;
}

export function AdminUserList({ users, currentUserId }: Props) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggleRole(u: AdminUserRecord) {
    const nextRole = u.role === "admin" ? "user" : "admin";
    setError(null);
    setBusyId(u.id);
    startTransition(async () => {
      const result = await setUserRoleAction(u.id, nextRole);
      setBusyId(null);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ul className="commute-list">
        {users.map((u) => {
          const isSelf = u.id === currentUserId;
          return (
            <li key={u.id} className="commute-list-row">
              <div>
                <p className="commute-list-name">{u.email}</p>
                <p className="editor-hint">
                  {u.role === "admin" ? "Admin" : "User"} · Joined {when.format(u.createdAt)}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => toggleRole(u)}
                disabled={isSelf || (pending && busyId === u.id)}
                title={isSelf ? "You can't change your own role" : undefined}
              >
                {u.role === "admin" ? "Remove admin" : "Make admin"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
