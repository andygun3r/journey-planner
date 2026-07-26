export default function LoadingService() {
  return (
    <main aria-busy="true" aria-label="Loading service">
      <div className="results-head">
        <h1>Loading service…</h1>
      </div>
      <div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton-row" />
        ))}
      </div>
    </main>
  );
}
