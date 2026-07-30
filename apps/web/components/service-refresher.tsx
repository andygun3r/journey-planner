"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useServicePosition } from "./service-live";

/**
 * Keeps the service page's server-rendered calling pattern fresh.
 *
 * The plain BoardRefresher re-fetches the route every 30 seconds regardless —
 * a train sitting still overnight got the same treatment as one running. Here
 * the refresh is driven by the same stream the position map uses, so a service
 * that has not moved costs nothing, and one that has updates within a second
 * rather than up to thirty.
 *
 * The 30-second timer stays as the fallback, running only while the stream is
 * not delivering. Both together would defeat the point.
 *
 * It shares the map's EventSource: useServicePosition is backed by one
 * reference-counted connection per rid, so this adds a listener rather than a
 * second stream.
 */
export function ServiceRefresher({ rid, intervalMs = 30_000 }: { rid: string; intervalMs?: number }) {
  const router = useRouter();
  const [secondsAgo, setSecondsAgo] = useState(0);
  const { position, streaming } = useServicePosition(rid);

  // What the page would actually render differently. The stream ticks on a
  // timer as well as on events — a departed train slides along its leg with the
  // clock, so its coordinates change constantly — and refreshing the whole
  // server page on every one of those would be worse than the 30s timer this
  // replaces. Only a real change to the calling pattern's inputs counts.
  //
  // Undefined on the first delivery, which is the stream telling us what the
  // server already rendered.
  const lastRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const tick = setInterval(() => setSecondsAgo((s) => s + 1), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (position === undefined) return;
    const signature = position
      ? `${position.atCrs ?? ""}|${position.event ?? ""}|${position.latenessMinutes ?? ""}`
      : "";
    const previous = lastRef.current;
    lastRef.current = signature;
    if (previous === undefined || previous === signature) return;
    router.refresh();
    setSecondsAgo(0);
  }, [position, router]);

  useEffect(() => {
    if (streaming) return;
    const refresh = setInterval(() => {
      router.refresh();
      setSecondsAgo(0);
    }, intervalMs);
    return () => clearInterval(refresh);
  }, [router, intervalMs, streaming]);

  // Coming back to a backgrounded tab, the picture is stale whatever the stream
  // has been doing — anything published while away is gone, since Redis pub/sub
  // has no replay.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) return;
      router.refresh();
      setSecondsAgo(0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [router]);

  return (
    <span className="board-refresh" aria-live="polite">
      Updated {secondsAgo === 0 ? "just now" : `${secondsAgo}s ago`}
    </span>
  );
}
