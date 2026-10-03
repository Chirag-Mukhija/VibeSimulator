import { useEffect, useRef, useState } from "react";
import { loadGalleryIndex, readTraceFile, type GalleryEntry } from "../lib/data.ts";
import { href, navigate } from "../lib/router.ts";
import { TopBar } from "../components/TopBar.tsx";
import { Icon } from "../components/ui.tsx";

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
      <div className="page">
        <section className="hero">
          <span className="chip accent" style={{ justifySelf: "start" }}>Read from your code, not guessed</span>
          <h1>See how every request <em>really</em> moves through your backend.</h1>
          <p>
            vibeSimulator reads a repository and shows each path from a click to the response: every function, query, Redis
            command and API call, with the line of code that proves it, and what will break when traffic grows.
          </p>
        </section>

        <div className="steps-3">
          <button
            className={`dropzone${over ? " over" : ""}`}
            onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void open(e.dataTransfer.files[0]); }}
            data-testid="dropzone"
          >
            <span className="row" style={{ fontWeight: 600 }}><Icon name="upload" />Open your trace</span>
            <span className="muted" style={{ fontSize: 13 }}>Drop a <span className="mono">vibesim.trace.json</span> here or click to choose. It's read in your browser and never uploaded.</span>
            {error && <span className="error-box">{error}</span>}
          </button>
          <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => void open(e.target.files?.[0])} data-testid="file-input" />
          <div className="step-card">
            <span className="n">MAKE A TRACE</span>
            <span>Run the analyzer on any JavaScript or TypeScript backend, on your own machine:</span>
            <code className="cmd">pnpm vibesim analyze path/to/repo</code>
            <span className="faint" style={{ fontSize: 12.5 }}>Express, Next.js, Postgres, Prisma, Drizzle, Mongoose, Redis, BullMQ, WebSockets, socket.io and more.</span>
          </div>
        </div>

        <section className="section">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h2>Explore real backends</h2>
            <span className="faint">Pre-analyzed, nothing to install</span>
          </div>
          <div className="cards">
            {gallery.map((g) => (
              <a key={g.id} className="card" href={href(["repo", g.id])} data-testid="gallery-card">
                <h3>{g.title}</h3>
                <p>{g.tagline}</p>
                <div className="row wrap" style={{ gap: 5 }}>{g.stack.map((s) => <span key={s} className="chip">{s}</span>)}</div>
                <div className="stat-row">
                  <span><b>{g.stats.routes}</b> routes</span>
                  <span><b>{g.stats.flows}</b> flows</span>
                  <span><b>{g.stats.findings}</b> findings{g.stats.high ? <> · <span className="sev-text high">{g.stats.high} high</span></> : null}</span>
                </div>
                <span className="faint" style={{ fontSize: 12 }}>{g.author}{g.license ? ` · ${g.license}` : ""}</span>
              </a>
            ))}
            {!gallery.length && <div className="card faint">The gallery is empty in this build.</div>}
          </div>
        </section>

        <section className="section">
          <h2>What you'll see</h2>
          <div className="steps-3">
            <div className="step-card"><span className="n">01 · FLOWS</span><b>Every request, hop by hop</b><span className="muted">An animated sequence diagram from the click or timer that starts it to the database and back, including middleware you didn't know ran.</span></div>
            <div className="step-card"><span className="n">02 · PROOF</span><b>Each arrow cites its line</b><span className="muted">Protocol, connection type (pooled, persistent, new each time) and the exact code. Anything the parser can't prove is shown dashed, never guessed.</span></div>
            <div className="step-card"><span className="n">03 · SCALE</span><b>What breaks with real users</b><span className="muted">N+1 queries, polling, blocking CPU work, missing indexes, state that breaks with two servers, each explained in plain words with a fix.</span></div>
          </div>
        </section>

        <section className="section">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h2>Learn the concepts behind the arrows</h2>
            <a href="#/learn">All concepts →</a>
          </div>
          <p className="muted" style={{ margin: 0 }}>Polling vs WebSockets, connection pools, queues, load balancers, the event loop: each with a simulation you can push until it breaks.</p>
        </section>
      </div>
    </>
  );
}
