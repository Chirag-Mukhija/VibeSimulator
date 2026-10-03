import { useEffect, useRef, useState } from "react";
import { loadGalleryIndex, readTraceFile, type GalleryEntry } from "../lib/data.ts";
import { href, navigate } from "../lib/router.ts";
import { TopBar } from "../components/TopBar.tsx";
import { Icon } from "../components/ui.tsx";

const EXAMPLE = href(["repo", "job-scheduler"], { tab: "flows", flow: "flow:route:POST:/jobs" });

export function Home() {
  const [gallery, setGallery] = useState<GalleryEntry[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    loadGalleryIndex().then(setGallery).catch(() => setGallery([]));
  }, []);

  const open = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    try {
      await readTraceFile(file);
      navigate(["repo", "local"]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <TopBar />
      <div className="page home">
        <section className="home-hero">
          <div className="home-intro">
            <span className="eyebrow">Static analysis for JavaScript and TypeScript backends</span>
            <h1>See how every request moves through your backend.</h1>
            <p>
              vibeSimulator reads a repository and traces each path from a click, timer or message to the database and
              back: every function, query, Redis command and API call, with the line of code that makes it. Then it shows
              what gives out first when traffic grows.
            </p>
            <div className="row wrap" style={{ gap: 10 }}>
              <a className="btn primary" href={EXAMPLE}>Walk through an example</a>
              <a className="btn" href="#/learn"><Icon name="book" size={15} />Concepts</a>
            </div>
          </div>
          <TraceExcerpt />
        </section>

        <section className="home-start" aria-label="Analyze your own repo">
          <div className="start-step">
            <span className="eyebrow">1 · Make a trace on your machine</span>
            <code className="cmd">pnpm vibesim analyze path/to/repo</code>
            <span className="faint" style={{ fontSize: 12.5 }}>Nothing is executed or uploaded, and no API key is needed.</span>
          </div>
          <button
            className={`dropzone${over ? " over" : ""}`}
            onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void open(e.dataTransfer.files[0]); }}
            data-testid="dropzone"
          >
            <span className="eyebrow">2 · Open it here</span>
            <span className="row" style={{ fontWeight: 600 }}><Icon name="upload" />Drop <span className="mono">vibesim.trace.json</span> or click to choose</span>
            <span className="faint" style={{ fontSize: 12.5 }}>Read in your browser, never sent anywhere.</span>
            {error && <span className="error-box">{error}</span>}
          </button>
          <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => void open(e.target.files?.[0])} data-testid="file-input" />
        </section>

        <section className="section">
          <div className="section-head">
            <h2>Real backends, already traced</h2>
            <span className="faint">Open one; nothing to install</span>
          </div>
          <div className="gallery">
            {gallery.map((g) => (
              <a key={g.id} className="gallery-row" href={href(["repo", g.id])} data-testid="gallery-card">
                <span className="gallery-name">
                  <b>{g.title}</b>
                  <span className="muted">{g.tagline}</span>
                </span>
                <span className="gallery-stack mono">{g.stack.join(" · ")}</span>
                <span className="gallery-stats">
                  <span><b>{g.stats.flows}</b> flows</span>
                  <span><b>{g.stats.findings}</b> findings{g.stats.high ? <span className="sev-text high"> · {g.stats.high} high</span> : null}</span>
                  <span className="faint">{g.author}{g.license ? ` · ${g.license}` : ""}</span>
                </span>
                <span className="gallery-go" aria-hidden="true">→</span>
              </a>
            ))}
            {!gallery.length && <div className="gallery-row faint">The gallery is empty in this build.</div>}
          </div>
        </section>

        <section className="section">
          <div className="section-head bare"><h2>What you get for each repo</h2></div>
          <dl className="spec">
            <div><dt>Flows</dt><dd><b>Every request, hop by hop.</b> A timing diagram from the click or timer that starts it to the database and back, including middleware you didn't know ran.</dd></div>
            <div><dt>Evidence</dt><dd><b>Each arrow cites its line.</b> Protocol, connection type (pooled, persistent, new each time) and the code. What the parser can't prove is drawn dashed, never guessed.</dd></div>
            <div><dt>Findings</dt><dd><b>What breaks with real users.</b> N+1 queries, polling, blocking CPU work, missing indexes, state that breaks with two servers, each with a fix.</dd></div>
            <div><dt>Scale</dt><dd><b>Push it until it gives.</b> Simulate traffic on any path, see which part saturates first, then try more instances, a cache, a queue or push instead of polling.</dd></div>
          </dl>
        </section>
      </div>
    </>
  );
}

/** A real hop list from the Job Scheduler repo, drawn the way the flow view draws it. */
function TraceExcerpt() {
  const lanes = [
    { x: 46, label: "Browser", color: "var(--k-actor)" },
    { x: 178, label: "API", color: "var(--k-entry)" },
    { x: 310, label: "Postgres", color: "var(--k-database)" },
    { x: 432, label: "Redis", color: "var(--k-cache)" },
  ];
  const hops = [
    { from: 0, to: 1, y: 78, proto: "HTTP", op: "POST /jobs", at: "routes/jobs.js:7", color: "var(--k-entry)" },
    { from: 1, to: 2, y: 124, proto: "SQL", op: "INSERT jobs", at: "services/queueService.js:11", color: "var(--k-database)" },
    { from: 1, to: 3, y: 170, proto: "Redis", op: "ZADD queue:priority", at: "services/redisQueue.js:12", color: "var(--k-cache)" },
    { from: 1, to: 3, y: 216, proto: "Redis", op: "PUBLISH job:events", at: "services/events.js:10", color: "var(--k-messaging)", async: true },
  ];
  return (
    <a className="excerpt" href={EXAMPLE} aria-label="Open the POST /jobs flow from the Job Scheduler repo">
      <div className="excerpt-head">
        <span className="mono"><b>POST /jobs</b></span>
        <span className="faint">Job Scheduler · 4 network calls</span>
      </div>
      <div className="excerpt-body">
        <svg viewBox="0 0 480 264" width="100%" role="img" aria-label="Sequence: browser posts a job; the API inserts it in Postgres, adds it to a Redis sorted set and publishes an event.">
          <defs>
            {hops.map((h, i) => (
              <marker key={i} id={`ex-arrow-${i}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 10 5 0 10z" fill={h.color} />
              </marker>
            ))}
          </defs>
          {lanes.map((l) => (
            <g key={l.label}>
              <line x1={l.x} x2={l.x} y1={40} y2={256} stroke="var(--border-strong)" strokeDasharray="3 5" />
              <rect x={l.x - 40} y={8} width={80} height={26} rx={4} fill="var(--bg-elev)" stroke="var(--border-strong)" />
              <rect x={l.x - 40} y={8} width={3} height={26} fill={l.color} />
              <text x={l.x + 2} y={25} textAnchor="middle" fontSize="11.5" fontWeight="600" fill="var(--text)">{l.label}</text>
            </g>
          ))}
          {hops.map((h, i) => {
            const x1 = lanes[h.from]!.x;
            const x2 = lanes[h.to]!.x - 4;
            const mid = (x1 + x2) / 2;
            return (
              <g key={i}>
                <line x1={x1} x2={x2} y1={h.y} y2={h.y} stroke={h.color} strokeWidth={1.6} strokeDasharray={h.async ? "5 4" : undefined} markerEnd={`url(#ex-arrow-${i})`} />
                <text x={mid} y={h.y - 7} textAnchor="middle" fontSize="10.5" fill="var(--text)">
                  <tspan fontFamily="var(--mono)" fontWeight="600" fill={h.color}>{h.proto}</tspan> {h.op}
                </text>
                <text x={mid} y={h.y + 15} textAnchor="middle" fontSize="9.5" fontFamily="var(--mono)" fill="var(--text-faint)">{h.at}</text>
              </g>
            );
          })}
          <line x1={lanes[1]!.x} x2={lanes[0]!.x + 4} y1={248} y2={248} stroke="var(--text-faint)" strokeWidth={1.2} strokeDasharray="2 3" />
          <text x={(lanes[0]!.x + lanes[1]!.x) / 2} y={242} textAnchor="middle" fontSize="10" fill="var(--text-faint)">response</text>
        </svg>
      </div>
      <div className="excerpt-foot faint">Every arrow links to the line that makes the call. Dashed means it doesn't wait.</div>
    </a>
  );
}
