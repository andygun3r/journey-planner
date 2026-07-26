import Link from "next/link";

/** Branded 404 — used by notFound() in boards/[crs] and services/[id]. */
export default function NotFound() {
  return (
    <main>
      <div className="notice">
        <h2>Not found</h2>
        <p>That page, station or service doesn&rsquo;t exist — it may have expired or the code is wrong.</p>
        <p>
          <Link className="btn btn-primary" href="/">
            Back to search
          </Link>
        </p>
      </div>
    </main>
  );
}
