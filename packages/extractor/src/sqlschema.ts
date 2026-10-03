/**
 * Reads CREATE TABLE / CREATE INDEX / ALTER TABLE statements from the repo's
 * .sql files (migrations, schema.sql) so queries can be checked against real
 * keys and indexes instead of guesses.
 */

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  /** "primary key", "unique constraint" or "index". */
  source: "primary key" | "unique constraint" | "index";
  file: string;
  line: number;
}

export interface TableInfo {
  name: string;
  columns: string[];
  indexes: IndexInfo[];
  file: string;
  line: number;
}

export type SqlSchema = Map<string, TableInfo>;

export function parseSqlSchema(files: { file: string; text: string }[]): SqlSchema {
  const tables: SqlSchema = new Map();
  // Migrations apply in file-name order.
  for (const { file, text } of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    const clean = text.replace(/--[^\n]*/g, (m) => " ".repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const lineAt = (index: number) => clean.slice(0, index).split("\n").length;
    for (const m of clean.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`]+)\s*\(/gi)) {
      const name = ident(m[1]!);
      const bodyStart = m.index! + m[0].length;
      const body = balanced(clean, bodyStart - 1);
      const t: TableInfo = { name, columns: [], indexes: [], file, line: lineAt(m.index!) };
      for (const part of splitTop(body)) {
        const p = part.trim();
        let c: RegExpExecArray | null;
        if ((c = /^(?:constraint\s+[\w"]+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(p))) {
          t.indexes.push({ name: `${name}_pkey`, columns: cols(c[1]!), unique: true, source: "primary key", file, line: t.line });
        } else if ((c = /^(?:constraint\s+([\w"]+)\s+)?unique\s*\(([^)]*)\)/i.exec(p))) {
          t.indexes.push({ name: ident(c[1] ?? `${name}_unique`), columns: cols(c[2]!), unique: true, source: "unique constraint", file, line: t.line });
        } else if (/^(constraint|check|foreign\s+key|exclude)\b/i.test(p)) {
          continue;
        } else {
          const col = /^([\w"`]+)\s+/.exec(p);
          if (!col) continue;
          const cname = ident(col[1]!);
          t.columns.push(cname);
          if (/\bprimary\s+key\b/i.test(p)) t.indexes.push({ name: `${name}_pkey`, columns: [cname], unique: true, source: "primary key", file, line: t.line });
          else if (/\bunique\b/i.test(p)) t.indexes.push({ name: `${name}_${cname}_key`, columns: [cname], unique: true, source: "unique constraint", file, line: t.line });
        }
      }
      tables.set(name, t);
    }
    for (const m of clean.matchAll(/create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([\w."]+)\s+on\s+(?:only\s+)?([\w."`]+)\s*(?:using\s+\w+\s*)?\(([^;]*?)\)\s*(?:where\b[^;]*)?;/gi)) {
      const t = tables.get(ident(m[3]!));
      if (!t) continue;
      t.indexes.push({ name: ident(m[2]!), columns: cols(m[4]!), unique: !!m[1], source: "index", file, line: lineAt(m.index!) });
    }
    for (const m of clean.matchAll(/drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?([\w."]+)/gi)) {
      const name = ident(m[1]!);
      for (const t of tables.values()) t.indexes = t.indexes.filter((i) => i.name !== name);
    }
    for (const m of clean.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([\w."`]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([\w"`]+)([^;]*);/gi)) {
      const t = tables.get(ident(m[1]!));
      if (!t) continue;
      const cname = ident(m[2]!);
      t.columns.push(cname);
      if (/\bunique\b/i.test(m[3]!)) t.indexes.push({ name: `${t.name}_${cname}_key`, columns: [cname], unique: true, source: "unique constraint", file, line: lineAt(m.index!) });
    }
    for (const m of clean.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([\w."`]+)\s+add\s+(?:constraint\s+([\w"]+)\s+)?(unique|primary\s+key)\s*\(([^)]*)\)/gi)) {
      const t = tables.get(ident(m[1]!));
      if (!t) continue;
      const pk = /primary/i.test(m[3]!);
      t.indexes.push({ name: ident(m[2] ?? `${t.name}_${pk ? "pkey" : "unique"}`), columns: cols(m[4]!), unique: true, source: pk ? "primary key" : "unique constraint", file, line: lineAt(m.index!) });
    }
  }
  return tables;
}

export interface QueryFacts {
  /** A unique key is fully pinned by equality predicates: at most one row. */
  uniqueLookup: boolean;
  /** Equality columns with no index whose leading column covers them. */
  unindexed: string[];
}

/** Checks a single-table WHERE clause against the table's keys and indexes. */
export function checkQuery(table: TableInfo, whereColumns: string[]): QueryFacts {
  const where = new Set(whereColumns);
  const uniqueLookup = table.indexes.some((i) => i.unique && i.columns.every((c) => where.has(c)));
  const indexed = table.indexes.some((i) => i.columns[0] !== undefined && where.has(i.columns[0]));
  return { uniqueLookup, unindexed: indexed || !whereColumns.length ? [] : whereColumns };
}

/** Indexes made redundant by another index or key with the same leading columns. */
export function redundantIndexes(table: TableInfo): { index: IndexInfo; coveredBy: IndexInfo }[] {
  const out: { index: IndexInfo; coveredBy: IndexInfo }[] = [];
  for (const idx of table.indexes) {
    if (idx.source !== "index") continue;
    const cover = table.indexes.find((o) => o !== idx && o.columns.length >= idx.columns.length && idx.columns.every((c, i) => o.columns[i] === c)
      && (o.source !== "index" || o.columns.length > idx.columns.length));
    if (cover) out.push({ index: idx, coveredBy: cover });
  }
  return out;
}

function ident(s: string): string {
  const parts = s.replace(/["`]/g, "").split(".");
  return parts[parts.length - 1]!.toLowerCase();
}

function cols(list: string): string[] {
  return splitTop(list).map((c) => ident(c.trim().split(/\s+/)[0]!)).filter(Boolean);
}

function balanced(text: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(openIndex + 1, i);
  }
  return text.slice(openIndex + 1);
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
