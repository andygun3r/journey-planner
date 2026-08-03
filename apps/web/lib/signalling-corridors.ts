export type SignallingCorridorId = "swml";

export interface SignallingCorridor {
  id: SignallingCorridorId;
  title: string;
  shortTitle: string;
  stationCrs: string[];
}

export const SIGNALLING_CORRIDORS: Record<SignallingCorridorId, SignallingCorridor> = {
  swml: {
    id: "swml",
    title: "South West Main Line",
    shortTitle: "SWML",
    stationCrs: [
      "WAT",
      "VXH",
      "QRB",
      "CLJ",
      "EAD",
      "WIM",
      "RAY",
      "NEM",
      "BRS",
      "SUR",
      "ESH",
      "HER",
      "WAL",
      "WYB",
      "BFN",
      "WBY",
      "WOK",
      "BKO",
      "FNB",
      "FLE",
      "WNF",
      "HOK",
      "BSK",
      "MIC",
      "WIN",
      "SHW",
      "ESL",
      "SOA",
      "SOU",
      "MBK",
      "RDB",
      "TTN",
      "ANF",
      "BEU",
      "BCU",
      "SWY",
      "NWM",
      "HNA",
      "CHR",
      "POK",
      "BMH",
      "BSM",
      "PKS",
      "POO",
      "HAM",
      "WRM",
      "WOO",
      "MTN",
      "DCH",
      "UPW",
      "WEY",
    ],
  },
};

export function namedSignallingCorridor(value: string | undefined): SignallingCorridor | undefined {
  if (!value) return undefined;
  return SIGNALLING_CORRIDORS[value.toLowerCase() as SignallingCorridorId];
}

export function stationSignallingCorridor(crs: string): SignallingCorridor | undefined {
  const normalized = crs.toUpperCase();
  return Object.values(SIGNALLING_CORRIDORS).find((corridor) =>
    corridor.stationCrs.includes(normalized),
  );
}
