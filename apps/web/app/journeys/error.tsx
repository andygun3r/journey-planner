"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function JourneysError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main>
      <div className="notice notice-danger">
        <h2>Couldn&rsquo;t load journeys</h2>
        <p>Something went wrong planning that journey. Try again, or start a new search.</p>
        <p>
          <button type="button" className="btn" onClick={reset}>
            Try again
          </button>{" "}
          <Link className="btn btn-secondary" href="/">
            New search
          </Link>
        </p>
      </div>
    </main>
  );
}
