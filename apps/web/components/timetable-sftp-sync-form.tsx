"use client";

import { useState } from "react";

type Phase = "idle" | "running" | "done" | "error";

export function TimetableSftpSyncForm() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [token, setToken] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    setLines([]);
    setPhase("running");

    const res = await fetch("/api/etl/sftp-sync", {
      method: "POST",
      headers: { "x-etl-upload-token": token },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      setLines([`Sync failed: ${body.error ?? res.statusText}`]);
      setPhase("error");
      return;
    }

    const { jobId } = (await res.json()) as { jobId: string };

    const source = new EventSource(`/api/etl/upload/${jobId}/stream`);
    source.addEventListener("line", (ev) => {
      setLines((prev) => [...prev, JSON.parse((ev as MessageEvent).data) as string]);
    });
    source.addEventListener("status", (ev) => {
      const status = (ev as MessageEvent).data as Phase;
      setPhase(status);
      source.close();
    });
    source.addEventListener("error", () => {
      source.close();
    });
  }

  const busy = phase === "running";

  return (
    <>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="etl-sftp-token">Upload token</label>
          <input
            id="etl-sftp-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Syncing…" : "Sync from SFTP now"}
        </button>
      </form>

      {lines.length > 0 && (
        <pre className="etl-log" aria-live="polite">
          {lines.join("\n")}
        </pre>
      )}

      {phase === "done" && <div className="notice">SFTP sync applied successfully.</div>}
      {phase === "error" && <div className="notice notice-danger">Sync failed — see log above.</div>}
    </>
  );
}
