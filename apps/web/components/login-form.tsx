"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

type MagicLinkPhase = "idle" | "sending" | "sent" | "error";
type PasskeyPhase = "idle" | "signing-in" | "error";

/** Sign-in form: passkey first (one tap if you have one), magic link as the fallback. */
export function LoginForm() {
  const [email, setEmail] = useState("");
  const [magicPhase, setMagicPhase] = useState<MagicLinkPhase>("idle");
  const [passkeyPhase, setPasskeyPhase] = useState<PasskeyPhase>("idle");

  async function handlePasskey() {
    setPasskeyPhase("signing-in");
    const { error } = await authClient.signIn.passkey();
    if (error) {
      setPasskeyPhase("error");
      return;
    }
    window.location.href = "/";
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setMagicPhase("sending");
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: "/",
    });
    setMagicPhase(error ? "error" : "sent");
  }

  return (
    <div className="field" style={{ gap: "1.5rem" }}>
      <div className="field">
        <button type="button" className="btn btn-primary" onClick={handlePasskey} disabled={passkeyPhase === "signing-in"}>
          {passkeyPhase === "signing-in" ? "Checking…" : "Continue with passkey"}
        </button>
        {passkeyPhase === "error" && (
          <div className="notice notice-danger">That didn&apos;t work — try a magic link instead.</div>
        )}
      </div>

      <p>or</p>

      <form onSubmit={handleMagicLink} className="field">
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={magicPhase === "sending" || magicPhase === "sent"}
        />
        <button type="submit" className="btn" disabled={magicPhase === "sending" || magicPhase === "sent"}>
          {magicPhase === "sending" ? "Sending…" : "Email me a sign-in link"}
        </button>
        {magicPhase === "sent" && (
          <div className="notice">Check your email — the link signs you in on this device.</div>
        )}
        {magicPhase === "error" && <div className="notice notice-danger">Couldn&apos;t send that — try again.</div>}
      </form>
    </div>
  );
}
