import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
await p.goto('http://localhost:3000/map', { waitUntil: 'networkidle', timeout: 45000 });
await p.waitForTimeout(6000);

const trainPos = await p.evaluate(async () => {
  const res = await fetch('/api/live-trains', { cache: 'no-store' });
  const data = await res.json();
  const near = data.trains.filter(t => Math.abs(t.lat-51.5)<0.4 && Math.abs(t.lon-(-0.1))<0.4);
  return near[0] ? { lat: near[0].lat, lon: near[0].lon, late: near[0].latenessMinutes } : null;
});
console.log('train:', trainPos);

if (trainPos) {
  await p.evaluate(({lat,lon}) => {
    window.__debugMap.jumpTo({ center: [lon, lat], zoom: 16 });
  }, trainPos);
  await p.waitForTimeout(2500);
}
await p.screenshot({ path: 'debug-train-close.png' });
await b.close();
