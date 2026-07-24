export default function LoadingBoard() {
  return (
    <main aria-busy="true" aria-label="Loading departures">
      <div className="results-head">
        <h1>Loading departures…</h1>
      </div>
      <div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton-row" />
        ))}
      </div>
    </main>
  );
}
