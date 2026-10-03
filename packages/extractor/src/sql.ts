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
  const label = table ? `${op} ${table}` : op === "OTHER" ? truncate(text, 40) : op;
  return { op, table, label, text: truncate(text, 400), hasLimit, aggregate, singleRow };
}

function match(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1];
}
