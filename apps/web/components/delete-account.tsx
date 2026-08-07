"use client";

import { useState, useTransition } from "react";
import { deleteAccountAction } from "@/app/settings/actions";

/** Two-step confirm — destructive and permanent, so one click isn't enough. */
export function DeleteAccount() {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <button type="button" className="btn-link-danger" onClick={() => setConfirming(true)}>
        Delete my account
      </button>
    );
  }

  return (
    <div className="notice notice-danger">
      <h2>Delete your account?</h2>
      <p>
        This permanently removes your account, commutes, holidays, favourites and passkeys. It
        can&rsquo;t be undone.
      </p>
      <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.6rem" }}>
        <button
          type="button"
          className="btn-danger-outline"
          disabled={pending}
          onClick={() => startTransition(() => deleteAccountAction())}
        >
          {pending ? "Deleting…" : "Yes, delete my account"}
        </button>
        <button type="button" className="btn-link" onClick={() => setConfirming(false)} disabled={pending}>
          Cancel
        </button>
      </div>
    </div>
  );
}
