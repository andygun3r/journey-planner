import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
await p.goto('http://localhost:3000/map', { waitUntil: 'networkidle', timeout: 45000 });
await p.waitForTimeout(6000);

// Find a train icon on-screen by scanning small grid clicks isn't reliable;
// instead read the GeoJSON source data via evaluate against maplibre's global.
const trainPos = await p.evaluate(async () => {
  const res = await fetch('/api/live-trains', { cache: 'no-store' });
  const data = await res.json();
  // pick a train near London center for visibility
  const near = data.trains.find(t => Math.abs(t.lat-51.5)<0.3 && Math.abs(t.lon-(-0.1))<0.3);
  return near ? { lat: near.lat, lon: near.lon, id: near.id, late: near.latenessMinutes } : null;
});
console.log('picked train:', trainPos);

if (trainPos) {
  // Use maplibre's project via page eval - but map instance isn't global.
  // Instead, pan the map to center on this train using the URL isn't supported;
  // simplest: just wait, then use JS to find canvas center after we know map centers on geolocation/default.
}
await b.close();
