import { truncate } from "./util.ts";

export interface SqlSummary {
  op: string;
  table?: string;
  label: string;
  text: string;
  hasLimit: boolean;
  aggregate: boolean;
  /** WHERE id = $n style lookup: returns at most one row. */
  singleRow: boolean;
  /** Columns compared for equality in WHERE (`col = $1`, `col IN (...)`, `col = ANY($1)`). */
  whereColumns: string[];
  hasJoin: boolean;
}

/** Cheap, deterministic summary of a SQL string for labels and findings. */
export function summarizeSql(raw: string): SqlSummary {
  const text = raw.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").trim();
  const upper = text.toUpperCase();
  const first = (upper.match(/^[A-Z]+/) ?? ["OTHER"])[0];
  let op = first === "WITH" ? "SELECT" : first;
  let table: string | undefined;
  const name = String.raw`["\`]?([A-Za-z_][\w.]*)["\`]?`;
  if (op === "INSERT") table = match(text, new RegExp(String.raw`INSERT\s+INTO\s+${name}`, "i"));
  else if (op === "UPDATE") table = match(text, new RegExp(String.raw`UPDATE\s+${name}`, "i"));
  else if (op === "DELETE") table = match(text, new RegExp(String.raw`DELETE\s+FROM\s+${name}`, "i"));
  else if (op === "SELECT") table = match(text, new RegExp(String.raw`\bFROM\s+${name}`, "i"));
  if (!["SELECT", "INSERT", "UPDATE", "DELETE", "BEGIN", "COMMIT", "ROLLBACK"].includes(op)) op = first;

  const hasLimit = /\bLIMIT\b|\bFETCH\s+FIRST\b|\bTOP\s+\d/.test(upper);
  const aggregate = op === "SELECT" && /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/.test(upper) && !/\bGROUP\s+BY\b[\s\S]*\bHAVING\b/.test(upper);
  const singleRow = /\bWHERE\b[^;]*?\b(\w+\.)?id\s*=\s*(\$\d+|\?|:\w+)/i.test(text) || /^SELECT\s+1\b/i.test(text);
  const whereClause = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|\bOFFSET\b|\bRETURNING\b|\bFOR\s+UPDATE\b|$)/i.exec(text)?.[1] ?? "";
  const whereColumns = [...new Set([...whereClause.matchAll(/(?:\b\w+\.)?(\w+)\s*(?:=\s*(?:\$\d+|\?|:\w+|'[^']*'|\d+|ANY\s*\()|\s+IN\s*\()/gi)].map((m) => m[1]!.toLowerCase()))];
  const hasJoin = /\bJOIN\b/i.test(text);
  const label = table ? purposeLabel(op, table, text, { aggregate, singleRow, hasLimit, whereColumns, hasJoin }) : op === "OTHER" ? truncate(text, 40) : op;
  return { op, table: table?.toLowerCase(), label, text: truncate(text, 400), hasLimit, aggregate, singleRow, whereColumns, hasJoin };
}

function match(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1];
}

/** A short label that says what the statement is for: "SELECT jobs by id", "COUNT jobs per status", "UPDATE jobs SET status='failed' by id". */
function purposeLabel(op: string, table: string, text: string, f: { aggregate: boolean; singleRow: boolean; hasLimit: boolean; whereColumns: string[]; hasJoin: boolean }): string {
  const by = f.whereColumns.length ? ` by ${f.whereColumns.slice(0, 2).join(" + ")}` : "";
  if (op === "SELECT") {
    if (f.aggregate) {
      const fn = (/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.exec(text)?.[1] ?? "COUNT").toUpperCase();
      const group = /\bGROUP\s+BY\s+(?:\w+\.)?(\w+)/i.exec(text)?.[1];
      return `${fn} ${table}${group ? ` per ${group}` : ""}${by}`;
    }
    const joined = f.hasJoin ? [...text.matchAll(/\bJOIN\s+["`]?(\w+)/gi)].map((m) => m[1]).slice(0, 2) : [];
    const what = joined.length ? `${table} + ${joined.join(" + ")}` : table;
    const page = f.hasLimit && !f.singleRow ? (/\bOFFSET\b/i.test(text) ? ", page (LIMIT/OFFSET)" : ", page (LIMIT)") : "";
    return `SELECT ${what}${by}${page}`;
  }
  if (op === "UPDATE") {
    const set = /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|\bFROM\b|$)/i.exec(text)?.[1] ?? "";
    const cols = set.split(",").map((part) => {
      const m = /^\s*(\w+)\s*=\s*('[^']*')?/.exec(part);
      return m ? (m[2] ? `${m[1]}=${m[2]}` : m[1]) : undefined;
    }).filter(Boolean).slice(0, 2);
    return `UPDATE ${table}${cols.length ? ` SET ${cols.join(", ")}` : ""}${by}`;
  }
  if (op === "INSERT") return `INSERT ${table}${/\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(text) ? " (upsert)" : /\bON\s+CONFLICT\b/i.test(text) ? " (skip duplicates)" : ""}`;
  if (op === "DELETE") return `DELETE ${table}${by}`;
  return `${op} ${table}`;
}
