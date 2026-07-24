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
