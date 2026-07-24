import { createReadStream } from "node:fs";
import readline from "node:readline";

/** Minimal RFC-4180-ish CSV line parser (handles quoted fields + "" escapes). */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Stream a GTFS CSV file, yielding rows as header-keyed records. */
export async function* readGtfsCsv(
  filePath: string,
): AsyncGenerator<Record<string, string>> {
  const rl = readline.createInterface({
    input: createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  for await (const rawLine of rl) {
    const line = rawLine.replace(/^﻿/, "");
    if (line.trim() === "") continue;
    if (!header) {
      header = parseCsvLine(line).map((h) => h.trim());
      continue;
    }
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) row[header[i]!] = values[i] ?? "";
    yield row;
  }
}
