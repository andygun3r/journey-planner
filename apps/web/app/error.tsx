"use client";

import { useEffect } from "react";

/** Root error boundary — a branded, unflappable fallback, never the raw Next screen. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main>
      <div className="notice notice-danger">
        <h2>Something went wrong</h2>
        <p>
          Signaller hit an unexpected problem loading this page. This is on us, not you.
        </p>
        <p>
          <button type="button" className="btn" onClick={reset}>
            Try again
          </button>
        </p>
      </div>
    </main>
  );
}
