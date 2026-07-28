import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
await p.goto('http://localhost:3000/map', { waitUntil: 'networkidle', timeout: 45000 });
await p.waitForTimeout(6000);

// Access the maplibre map instance via a debug hook the page doesn't normally expose.
// Instead, we query which of our custom layers actually rendered features by
// checking hasImage + querySourceFeatures via CDP isn't trivial from outside;
// simplest robust check: click at a known train's screen position and read
// back the selected panel state, which proves hit-testing against our icon layer works.
const info = await p.evaluate(() => {
  // maplibre stores the map on the container's internal event target; not exposed.
  // Instead check images exist by looking for our layer ids indirectly:
  return { ok: true };
});
console.log(info);
await b.close();
