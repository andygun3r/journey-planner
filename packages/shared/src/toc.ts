/** ATOC two-letter TOC codes → passenger-facing operator names. */
const TOC_NAMES: Record<string, string> = {
  AW: "Transport for Wales",
  CC: "c2c",
  CH: "Chiltern Railways",
  CS: "Caledonian Sleeper",
  EM: "East Midlands Railway",
  ES: "Eurostar",
  GC: "Grand Central",
  GN: "Great Northern",
  GR: "LNER",
  GW: "GWR",
  GX: "Gatwick Express",
  HT: "Hull Trains",
  HX: "Heathrow Express",
  IL: "Island Line",
  LD: "Lumo",
  LE: "Greater Anglia",
  LM: "West Midlands Railway",
  LO: "London Overground",
  LT: "London Underground",
  ME: "Merseyrail",
  NT: "Northern",
  SE: "Southeastern",
  SN: "Southern",
  SP: "Swanage Railway",
  SR: "ScotRail",
  SW: "South Western Railway",
  TL: "Thameslink",
  TP: "TransPennine Express",
  TW: "Tyne & Wear Metro",
  VT: "Avanti West Coast",
  WM: "West Midlands Railway",
  XC: "CrossCountry",
  XR: "Elizabeth line",
};

export function tocName(code: string): string | undefined {
  return TOC_NAMES[code.toUpperCase()];
}

let tocCodesByName: Map<string, string> | null = null;

/** Passenger-facing operator name -> ATOC two-letter code (reverse of tocName). */
export function tocCodeForName(name: string): string | undefined {
  if (!tocCodesByName) {
    tocCodesByName = new Map(Object.entries(TOC_NAMES).map(([code, n]) => [n, code]));
  }
  return tocCodesByName.get(name);
}

/**
 * ATOC TOC codes → Network Rail operating region. Some TOCs (e.g. CrossCountry,
 * Avanti West Coast) run services across several NR regions — each is assigned to
 * its primary/HQ region here, so this is an approximation, not a precise coverage map.
 */
const TOC_REGIONS: Record<string, string> = {
  AW: "Wales & Western",
  CC: "Southern",
  CH: "London North Western",
  CS: "Scotland's Railway",
  EM: "East Midlands",
  ES: "Southern",
  GC: "London North Eastern",
  GN: "Anglia",
  GR: "London North Eastern",
  GW: "Wales & Western",
  GX: "Southern",
  HT: "London North Eastern",
  HX: "Southern",
  IL: "Southern",
  LD: "London North Eastern",
  LE: "Anglia",
  LM: "London North Western",
  LO: "Southern",
  LT: "Southern",
  ME: "London North Western",
  NT: "London North Western",
  SE: "Southern",
  SN: "Southern",
  SP: "Southern",
  SR: "Scotland's Railway",
  SW: "Wessex",
  TL: "Anglia",
  TP: "London North Western",
  TW: "London North Eastern",
  VT: "London North Western",
  WM: "London North Western",
  XC: "London North Western",
  XR: "Southern",
};

export function tocRegion(code: string): string | undefined {
  return TOC_REGIONS[code.toUpperCase()];
}

/**
 * dtd2mysql GTFS route_short_name looks like "GR:KGX->EDB:2"
 * (toc:origin->dest:mode). Extract a passenger-facing operator name.
 */
export function operatorFromRouteName(routeName: string | undefined): string | undefined {
  if (!routeName) return undefined;
  const toc = routeName.split(":")[0];
  if (toc && /^[A-Z]{2}$/i.test(toc)) return tocName(toc) ?? toc.toUpperCase();
  return routeName;
}
