import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KNOWN_TIMETABLE_TYPES } from "./prepare.js";

const exec = promisify(execFile);

/**
 * Distinguishes DTD timetable/fares zips from Network Rail Track Model zips
 * by peeking at what's inside — some RDG SFTP accounts drop every feed into
 * one shared folder with no per-feed subdirectories, so a directory listing
 * alone can't tell them apart (see track-model-sftp.ts's own NWR_TrackModel
 * detection, which this reuses the same signal for).
 *
 * `unzip -l` lists entries without extracting, cheap even for the
 * multi-hundred-MB zips this pipeline handles.
 */

const TRACK_MODEL_SIGNATURE = "nwr_trackcentrelines";

// "unreadable" is distinct from "other": a corrupted/truncated zip must
// never be accepted as a fares match (the "anything that isn't track-model
// or timetable is fares" fallback in sftp-download.ts), or a broken file
// would silently get handed to dtd2mysql and fail confusingly deep in the
// pipeline instead of being skipped up front with a clear reason.
export type ZipKind = "timetable" | "track-model" | "other" | "unreadable";

/** Null if the file isn't a valid zip `unzip` can list (corrupted/truncated/not a zip at all). */
async function listEntries(zipPath: string): Promise<string[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec("unzip", ["-l", zipPath], { maxBuffer: 10 * 1024 * 1024 }));
  } catch {
    return null;
  }
  // Entry lines look like "  <size>  <date> <time>   <name>" — skip the
  // header/footer/summary lines unzip -l always prints around the listing.
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).at(-1) ?? "")
    .filter(Boolean);
}

export async function classifyZip(zipPath: string): Promise<ZipKind> {
  const entries = await listEntries(zipPath);
  if (!entries) return "unreadable";
  const lower = entries.map((e) => e.toLowerCase());

  if (lower.some((e) => e.includes(TRACK_MODEL_SIGNATURE))) return "track-model";

  const looksLikeTimetable = entries.some((e) => {
    const match = /^(.*?)(?:[._-]?)([A-Za-z]{3})\.txt$/i.exec(e);
    const type = match?.[2]?.toUpperCase();
    if (type && KNOWN_TIMETABLE_TYPES.includes(type)) return true;
    const ext = e.split(".").pop()?.toUpperCase();
    return !!ext && KNOWN_TIMETABLE_TYPES.includes(ext);
  });
  if (looksLikeTimetable) return "timetable";

  return "other";
}
