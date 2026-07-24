export default function LoadingJourneys() {
  return (
    <main aria-busy="true" aria-label="Finding trains">
      <div className="results-head">
        <h1>Finding trains…</h1>
      </div>
      <div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton-row" />
        ))}
      </div>
    </main>
  );
}
