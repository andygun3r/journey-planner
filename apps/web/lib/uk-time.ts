/**
 * UK-local (Europe/London) time handling — re-exported from packages/shared,
 * which is where this now lives so services/nr-ingest can share it (see that
 * file's header for why: findRidForHeadcode needs the same HH:MM -> real
 * instant resolution to time-check a candidate schedule).
 *
 * Kept as a re-export rather than updating every apps/web call site to import
 * from @signaller/shared directly.
 */

export {
  londonDateKey,
  londonOffsetMinutes,
  londonOffsetString,
  parseHhmm,
  hhmmToIso,
  resolvePatternTimes,
  minutesLate,
  ukHhmm,
  ukParts,
  type UkParts,
} from "@signaller/shared";
