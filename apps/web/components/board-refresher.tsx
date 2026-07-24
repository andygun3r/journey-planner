"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Keeps a server-rendered board fresh. Re-fetches the route (server component
 * re-runs, live data re-queried) every `intervalMs`, pausing when the tab is
 * hidden so we don't hammer the API in the background. This is the polling
 * fallback; the SSE live stream (P4) will supersede it for per-row updates.
 */
export function BoardRefresher({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [secondsAgo, setSecondsAgo] = useState(0);

  useEffect(() => {
    let refresh: ReturnType<typeof setInterval> | undefined;
    const tick = setInterval(() => setSecondsAgo((s) => s + 1), 1000);

    function start() {
      stop();
      refresh = setInterval(() => {
        router.refresh();
        setSecondsAgo(0);
      }, intervalMs);
    }
    function stop() {
      if (refresh) clearInterval(refresh);
    }
    function onVisibility() {
      if (document.hidden) stop();
      else {
        router.refresh();
        setSecondsAgo(0);
        start();
      }
    }

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, intervalMs]);

  return (
    <span className="board-refresh" aria-live="polite">
      Updated {secondsAgo === 0 ? "just now" : `${secondsAgo}s ago`}
    </span>
  );
}
