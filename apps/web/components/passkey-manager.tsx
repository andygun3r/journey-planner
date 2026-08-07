"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

type Phase = "idle" | "busy" | "error";

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

/** Passkeys are managed entirely client-side — WebAuthn ceremonies must run in the browser. */
export function PasskeyManager() {
  const { data: passkeys, isPending } = authClient.useListPasskeys();
  const [phase, setPhase] = useState<Phase>("idle");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function addPasskey() {
    setPhase("busy");
    const { error } = await authClient.passkey.addPasskey();
    setPhase(error ? "error" : "idle");
  }

  async function removePasskey(id: string) {
    setBusyId(id);
    await authClient.passkey.deletePasskey({ id });
    setBusyId(null);
  }

  return (
    <div>
      {!isPending && passkeys && passkeys.length > 0 && (
        <ul className="commute-list">
          {passkeys.map((p) => (
            <li key={p.id} className="commute-list-row">
              <div>
                <p className="commute-list-name">{p.name || p.deviceType || "Passkey"}</p>
                <p className="editor-hint">Added {when.format(new Date(p.createdAt))}</p>
              </div>
              <button
                type="button"
                className="btn-link-danger"
                onClick={() => removePasskey(p.id)}
                disabled={busyId === p.id}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {!isPending && passkeys && passkeys.length === 0 && (
        <p className="editor-hint">No passkeys yet — add one for quick, passwordless sign-in.</p>
      )}
      <button type="button" className="btn btn-secondary" onClick={addPasskey} disabled={phase === "busy"}>
        {phase === "busy" ? "Adding…" : "Add a passkey"}
      </button>
      {phase === "error" && (
        <p className="form-error" role="alert">
          Couldn&rsquo;t add that passkey — try again.
        </p>
      )}
    </div>
  );
}
