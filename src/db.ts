import Dexie, { type Table } from "dexie";

export interface Row {
  id?: number;
  data: Record<string, string>;
}

export interface Meta {
  key: string; // always 'current'
  columns: string[];
  rowCount: number;
}

class AppDB extends Dexie {
  rows!: Table<Row, number>;
  meta!: Table<Meta, string>;

  constructor() {
    super("csvdb");
    this.version(1).stores({
      rows: "++id",
      meta: "key",
    });
  }
}

export const db = new AppDB();
