process.env.NODE_ENV = 'development';
const { refreshAllTflStops } = await import('./lib/tfl-stops.ts');
const { TFL_MODES } = await import('@mainline/shared');
console.log('starting refresh for modes:', TFL_MODES);
const t0 = Date.now();
const total = await refreshAllTflStops(TFL_MODES);
console.log('done in', Math.round((Date.now()-t0)/1000), 's, total upserted:', total);
process.exit(0);
