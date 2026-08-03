import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseSopFile } from "./load-sop.js";

async function tmpFile(name: string, body: string | Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mainline-sop-"));
  const file = path.join(dir, name);
  await writeFile(file, body);
  return file;
}

describe("parseSopFile", () => {
  it("loads JSON SOP rows with a file-level TD area", async () => {
    const file = await tmpFile(
      "Q0.json",
      JSON.stringify({
        tdArea: "Q0",
        rows: [{ address: "0b", bit: 2, itemType: "signal", itemId: "Q123", aspect: "off" }],
      }),
    );

    await expect(parseSopFile(file)).resolves.toEqual([
      {
        tdArea: "Q0",
        address: "0b",
        bit: 2,
        itemType: "signal",
        itemId: "Q123",
        aspect: "off",
        description: undefined,
      },
    ]);
  });

  it("loads normalized CSV rows and header aliases", async () => {
    const file = await tmpFile(
      "CC.csv",
      [
        "Area,Byte,Bit No,Type,Signal Number,Indication,Description",
        'CC,11,7,signal,C123,red,"platform starter"',
      ].join("\n"),
    );

    await expect(parseSopFile(file)).resolves.toEqual([
      {
        tdArea: "CC",
        address: "11",
        bit: 7,
        itemType: "signal",
        itemId: "C123",
        aspect: "red",
        description: "platform starter",
      },
    ]);
  });

  it("loads gzipped TSV rows", async () => {
    const file = await tmpFile(
      "WH.tsv.gz",
      gzipSync("tdArea\taddress\tbit\titemType\titemId\taspect\nWH\t0a\t0\tsignal\tW12\toff\n"),
    );

    await expect(parseSopFile(file)).resolves.toMatchObject([
      { tdArea: "WH", address: "0a", bit: 0, itemType: "signal", itemId: "W12", aspect: "off" },
    ]);
  });
});
