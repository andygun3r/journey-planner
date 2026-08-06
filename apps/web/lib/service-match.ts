/**
 * Re-export only. The implementation moved to `packages/shared/src/service-match.ts`
 * so services/nr-ingest can use the same calling-pattern scoring to disambiguate
 * a headcode between several candidate runs — the same reason `uk-time.ts` was
 * moved there earlier. Import from "@signaller/shared" in new code.
 */
export {
  alignCallsToRun,
  callKeys,
  isAcceptable,
  orderRunStops,
  pickBestRun,
  plausibleTdMatch,
  runWindow,
  scoreRun,
  windowDistance,
  TD_TOLERANCE_MS,
  type CandidateRun,
  type RouteStop,
  type RunPick,
  type RunScore,
  type RunStop,
  type TdMatch,
  type TdReport,
} from "@signaller/shared";
