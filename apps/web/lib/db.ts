import { createDb, type Db } from "@mainline/db";

let db: Db | null = null;

export function getDb(): Db {
  db ??= createDb();
  return db;
}
