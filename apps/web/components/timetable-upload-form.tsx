"use client";

import { useRef, useState } from "react";

type Phase = "idle" | "uploading" | "running" | "done" | "error";

function useEtlJob() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<string[]>([]);

  function watch(jobId: string, startedAs: Phase) {
    setPhase(startedAs);
    const source = new EventSource(`/api/etl/upload/${jobId}/stream`);
    source.addEventListener("line", (ev) => {
      setLines((prev) => [...prev, JSON.parse((ev as MessageEvent).data) as string]);
    });
    source.addEventListener("status", (ev) => {
      setPhase((ev as MessageEvent).data as Phase);
      source.close();
    });
    source.addEventListener("error", () => {
      source.close();
    });
  }

  function reset() {
    setLines([]);
  }

  return { phase, setPhase, lines, watch, reset };
}

// A bundle from `etl package` is tar.gz/tgz; a raw feed straight from the
// data provider (or SFTP) is a plain .zip. Same uploader, different backend
// endpoint — the user just picks a file, they don't need to know which kind
// it is.
function isBundleFile(name: string): boolean {
  return /\.(tar\.gz|tgz)$/i.test(name);
}

/** Button + log panel for the two ways to load a timetable: SFTP sync or a file upload. */
export function TimetableUploadForm({ sftpAvailable }: { sftpAvailable: boolean }) {
  const [showFileUpload, setShowFileUpload] = useState(!sftpAvailable);
  const sftp = useEtlJob();
  const upload = useEtlJob();
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleSftpSync() {
    sftp.reset();
    sftp.setPhase("running");
    const res = await fetch("/api/etl/sftp-sync", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      sftp.setPhase("error");
      alert(`Sync failed: ${body.error ?? res.statusText}`);
      return;
    }
    const { jobId } = (await res.json()) as { jobId: string };
    sftp.watch(jobId, "running");
  }

  async function handleFileUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    upload.reset();
    upload.setPhase("uploading");

    const bundle = isBundleFile(file.name);
    const form = new FormData();
    form.append(bundle ? "bundle" : "file", file);

    const res = await fetch(bundle ? "/api/etl/upload" : "/api/etl/upload-raw", {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      upload.setPhase("error");
      alert(`Upload failed: ${body.error ?? res.statusText}`);
      return;
    }

    const { jobId } = (await res.json()) as { jobId: string };
    upload.watch(jobId, "running");
  }

  const sftpBusy = sftp.phase === "running";
  const uploadBusy = upload.phase === "uploading" || upload.phase === "running";

  return (
    <>
      {sftpAvailable && (
        <div className="field">
          <p>Get the newest timetable straight from the rail data provider — one click, nothing to download.</p>
          <button type="button" className="btn btn-primary" onClick={handleSftpSync} disabled={sftpBusy}>
            {sftpBusy ? "Fetching…" : "Get latest timetable"}
          </button>

          {sftp.lines.length > 0 && (
            <pre className="etl-log" aria-live="polite">
              {sftp.lines.join("\n")}
            </pre>
          )}
          {sftp.phase === "done" && <div className="notice">Timetable updated.</div>}
          {sftp.phase === "error" && <div className="notice notice-danger">That didn&apos;t work — see the log above.</div>}
        </div>
      )}

      {sftpAvailable && !showFileUpload && (
        <button type="button" className="btn btn-link" onClick={() => setShowFileUpload(true)}>
          I have a timetable file to upload instead
        </button>
      )}

      {showFileUpload && (
        <form onSubmit={handleFileUpload}>
          <div className="field">
            <label htmlFor="etl-bundle">Timetable file</label>
            <input id="etl-bundle" ref={fileRef} type="file" accept=".zip,.tar.gz,.tgz" required />
          </div>
          <button type="submit" className="btn btn-primary" disabled={uploadBusy}>
            {uploadBusy ? "Working…" : "Upload and apply"}
          </button>

          {upload.lines.length > 0 && (
            <pre className="etl-log" aria-live="polite">
              {upload.lines.join("\n")}
            </pre>
          )}
          {upload.phase === "done" && <div className="notice">Timetable applied successfully.</div>}
          {upload.phase === "error" && (
            <div className="notice notice-danger">Apply failed — see log above.</div>
          )}
        </form>
      )}
    </>
  );
}
