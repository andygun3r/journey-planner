"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { PasskeyManager } from "@/components/passkey-manager";
import { DeleteAccount } from "@/components/delete-account";

interface Props {
  email: string;
}

export function AccountSection({ email }: Props) {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await authClient.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="notice">
      <h2>Account</h2>
      <p>{email}</p>

      <h3 className="editor-subhead">Passkeys</h3>
      <PasskeyManager />

      <div style={{ marginTop: "1.25rem", display: "flex", gap: "0.6rem", alignItems: "center" }}>
        <button type="button" className="btn btn-secondary" onClick={signOut} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
        <DeleteAccount />
      </div>
    </div>
  );
}
