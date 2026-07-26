"use client";

import { useRef, useState } from "react";

type Phase = "idle" | "uploading" | "running" | "done" | "error";

export function TimetableUploadForm() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [token, setToken] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setLines([]);
    setPhase("uploading");

    const form = new FormData();
    form.append("bundle", file);

    const res = await fetch("/api/etl/upload", {
      method: "POST",
      headers: { "x-etl-upload-token": token },
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      setLines([`Upload failed: ${body.error ?? res.statusText}`]);
      setPhase("error");
      return;
    }

    const { jobId } = (await res.json()) as { jobId: string };
    setPhase("running");

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

  const busy = phase === "uploading" || phase === "running";

  return (
    <>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="etl-token">Upload token</label>
          <input
            id="etl-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="etl-bundle">Bundle file</label>
          <input id="etl-bundle" ref={fileRef} type="file" accept=".tar.gz,.tgz" required />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Working…" : "Upload and apply"}
        </button>
      </form>

      {lines.length > 0 && (
        <pre className="etl-log" aria-live="polite">
          {lines.join("\n")}
        </pre>
      )}

      {phase === "done" && <div className="notice">Timetable applied successfully.</div>}
      {phase === "error" && <div className="notice notice-danger">Apply failed — see log above.</div>}
    </>
  );
}
