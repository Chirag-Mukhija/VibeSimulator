import type { ReactNode } from "react";
import type { Evidence } from "@vibesim/spec";

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "await", "async", "if", "else", "for", "of", "in", "while", "new", "try", "catch",
  "finally", "throw", "import", "from", "export", "default", "class", "extends", "this", "true", "false", "null", "undefined",
  "typeof", "instanceof", "switch", "case", "break", "continue", "require", "module", "exports", "SELECT", "FROM", "WHERE",
  "INSERT", "INTO", "UPDATE", "SET", "DELETE", "VALUES", "RETURNING", "ORDER", "BY", "LIMIT", "AND", "OR", "JOIN", "ON",
]);

/** Tiny tokenizer: enough to make evidence readable, not a full highlighter. */
function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\/\/.*$|\/\*.*?\*\/|--\s.*$)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1]) out.push(<span key={i++} className="tok-com">{m[1]}</span>);
    else if (m[2]) out.push(<span key={i++} className="tok-str">{m[2]}</span>);
    else if (m[3]) out.push(<span key={i++} className="tok-num">{m[3]}</span>);
    else if (m[4] && KEYWORDS.has(m[4])) out.push(<span key={i++} className="tok-kw">{m[4]}</span>);
    else out.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function CodeBlock({ evidence, title }: { evidence: Evidence; title?: string }) {
  const ctx = evidence.context ?? (evidence.snippet ? { startLine: evidence.line, lines: [evidence.snippet] } : undefined);
  return (
    <div className="code">
      <div className="code-head">
        <span className="ellipsis" title={evidence.file}>{title ?? evidence.file}</span>
        <span>line {evidence.line}</span>
      </div>
      {ctx ? (
        <pre>
          {trimIndent(ctx.lines).map((text, i) => {
            const ln = ctx.startLine + i;
            const hl = ln === evidence.line || (evidence.endLine !== undefined && ln > evidence.line && ln <= evidence.endLine);
            return (
              <div key={ln} className={`code-line${hl ? " hl" : ""}`}>
                <span className="ln">{ln}</span>
                <span>{highlight(text)}</span>
              </div>
            );
          })}
        </pre>
      ) : (
        <div className="empty" style={{ padding: 10 }}>No source in this trace (it was created with --no-source).</div>
      )}
    </div>
  );
}

function trimIndent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}
