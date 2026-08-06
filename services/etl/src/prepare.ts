import { execFile } from "node:child_process";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * dtd2mysql selects parsers by file EXTENSION (config/timetable maps
 * MSN, FLF, MCA, ZTR, ALF, CFA, TSI). RDM delivers files named like
 * RJTTF906MCA.txt, so we rename to RJTTF906.MCA and repack the zip.
 * Zips that already use dotted extensions pass through unchanged.
 */

export const KNOWN_TIMETABLE_TYPES = ["MSN", "FLF", "MCA", "ZTR", "ALF", "CFA", "TSI"];

export async function prepareTimetableZip(srcZip: string, destDir: string): Promise<string> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dtd-prepare-"));
  try {
    await exec("unzip", ["-o", "-q", srcZip, "-d", tmp]);
    const files = await readdir(tmp);
    let renamed = 0;
    for (const file of files) {
      const match = /^(.*?)(?:[._-]?)([A-Z]{3})\.txt$/i.exec(file);
      const type = match?.[2]?.toUpperCase();
      if (match && type && KNOWN_TIMETABLE_TYPES.includes(type)) {
        await rename(path.join(tmp, file), path.join(tmp, `${match[1]}.${type}`));
        renamed++;
      }
    }
    if (renamed === 0 && !files.some((f) => KNOWN_TIMETABLE_TYPES.includes(path.extname(f).slice(1).toUpperCase()))) {
      throw new Error(
        `prepare: no recognisable DTD timetable files in ${srcZip} (saw: ${files.join(", ")})`,
      );
    }
    const outZip = path.join(destDir, "timetable-prepared.zip");
    await rm(outZip, { force: true });
    // -0 (store): dtd2mysql only extracts, compression buys nothing here.
    await exec("zip", ["-0", "-q", "-j", outZip, ...(await readdir(tmp)).map((f) => path.join(tmp, f))], {
      maxBuffer: 10 * 1024 * 1024,
    });
    console.log(`Prepared ${renamed} renamed files -> ${outZip}`);
    return outZip;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
