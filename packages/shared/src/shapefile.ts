/**
 * Minimal reader for the ESRI Shapefile format, covering only what Network
 * Rail's Track Model needs: shape type 1 (Point) and 3 (PolyLine), and DBF
 * field types 'N' (numeric) and 'C' (character).
 *
 * Hand-rolled rather than a dependency: the formats are simple, stable, and
 * publicly specified, and this only ever needs one sequential pass per file
 * (a one-off ETL precompute, not a live query path) — no random access, so
 * the .shx index file is never read.
 *
 * DBF field types 'N' (Numeric) and 'F' (Float) both parse as numbers here —
 * Track Model's own mileage fields are typed 'F', confirmed against the real
 * files, not 'N' as might be assumed from the DBF spec's more commonly cited
 * numeric type.
 */

export interface ShpPolyLineRecord {
  /** Each part is a ring/segment of [x, y] points in the file's native CRS. */
  parts: [number, number][][];
}

export interface ShpPointRecord {
  point: [number, number];
}

const SHP_HEADER_BYTES = 100;
const SHAPE_TYPE_POINT = 1;
const SHAPE_TYPE_POLYLINE = 3;
const SHAPE_TYPE_NULL = 0;

function readShpRecords(buf: Buffer): Buffer[] {
  const fileLengthWords = buf.readInt32BE(24);
  const fileLengthBytes = fileLengthWords * 2;
  const records: Buffer[] = [];
  let offset = SHP_HEADER_BYTES;
  while (offset < fileLengthBytes) {
    const contentLengthWords = buf.readInt32BE(offset + 4);
    const contentLengthBytes = contentLengthWords * 2;
    const bodyStart = offset + 8;
    records.push(buf.subarray(bodyStart, bodyStart + contentLengthBytes));
    offset = bodyStart + contentLengthBytes;
  }
  return records;
}

export function readShpPolyLines(buf: Buffer): ShpPolyLineRecord[] {
  return readShpRecords(buf).map((body) => {
    const shapeType = body.readInt32LE(0);
    if (shapeType === SHAPE_TYPE_NULL) return { parts: [] };
    if (shapeType !== SHAPE_TYPE_POLYLINE) {
      throw new Error(`expected PolyLine (3), got shape type ${shapeType}`);
    }
    const numParts = body.readInt32LE(36);
    const numPoints = body.readInt32LE(40);
    const partStarts: number[] = [];
    for (let i = 0; i < numParts; i++) partStarts.push(body.readInt32LE(44 + i * 4));

    const pointsOffset = 44 + numParts * 4;
    const points: [number, number][] = [];
    for (let i = 0; i < numPoints; i++) {
      const base = pointsOffset + i * 16;
      points.push([body.readDoubleLE(base), body.readDoubleLE(base + 8)]);
    }

    const parts: [number, number][][] = partStarts.map((start, i) => {
      const end = i + 1 < partStarts.length ? partStarts[i + 1] : numPoints;
      return points.slice(start, end);
    });
    return { parts };
  });
}

export function readShpPoints(buf: Buffer): ShpPointRecord[] {
  return readShpRecords(buf).map((body) => {
    const shapeType = body.readInt32LE(0);
    if (shapeType === SHAPE_TYPE_NULL) return { point: [NaN, NaN] };
    if (shapeType !== SHAPE_TYPE_POINT) {
      throw new Error(`expected Point (1), got shape type ${shapeType}`);
    }
    return { point: [body.readDoubleLE(4), body.readDoubleLE(12)] };
  });
}

const DBF_HEADER_BYTES = 32;
const DBF_FIELD_DESCRIPTOR_BYTES = 32;
const DBF_FIELD_TERMINATOR = 0x0d;

export function readDbf(buf: Buffer): Record<string, string | number>[] {
  const headerLength = buf.readUInt16LE(8);
  const recordLength = buf.readUInt16LE(10);
  const numRecords = buf.readUInt32LE(4);

  const fields: { name: string; type: string; length: number }[] = [];
  let offset = DBF_HEADER_BYTES;
  while (buf[offset] !== DBF_FIELD_TERMINATOR) {
    const name = buf
      .subarray(offset, offset + 11)
      .toString("latin1")
      .replace(/\0.*$/, "");
    const type = buf.subarray(offset + 11, offset + 12).toString("latin1");
    const length = buf.readUInt8(offset + 16);
    fields.push({ name, type, length });
    offset += DBF_FIELD_DESCRIPTOR_BYTES;
  }

  const records: Record<string, string | number>[] = [];
  for (let i = 0; i < numRecords; i++) {
    const recordStart = headerLength + i * recordLength;
    let fieldOffset = recordStart + 1; // skip the deletion flag byte
    const row: Record<string, string | number> = {};
    for (const field of fields) {
      const raw = buf
        .subarray(fieldOffset, fieldOffset + field.length)
        .toString("latin1")
        .trim();
      row[field.name] = (field.type === "N" || field.type === "F") && raw !== "" ? Number(raw) : raw;
      fieldOffset += field.length;
    }
    records.push(row);
  }
  return records;
}
