import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Repo } from "./project.ts";

export interface ProcessEntry {
  name: string;
  /** Repo-relative entry file. */
  file: string;
  evidence: { file: string; line: number };
}

export interface Datastore {
  name: string;
  image: string;
  engine: string;
  evidence: { file: string; line: number };
}

export interface ProxyInfo {
  name: string;
  listen: { file: string; line: number };
  proxyPass: { file: string; line: number };
  upstreams: string[];
  rateLimit?: string;
}

export interface Infra {
  processes: ProcessEntry[];
  datastores: Datastore[];
  proxies: ProxyInfo[];
}

const RUNNER = /\b(?:node|nodemon|tsx|ts-node|bun|deno run)\s+(?:--?[\w-]+(?:=\S+)?\s+)*["']?([\w./-]+\.(?:[cm]?[jt]s))["']?/;
const ENGINES: [RegExp, string][] = [
  [/postgres|postgis|timescale/i, "postgres"],
  [/mysql|mariadb/i, "mysql"],
  [/mongo/i, "mongodb"],
  [/redis|valkey|keydb/i, "redis"],
  [/rabbitmq/i, "rabbitmq"],
  [/kafka|redpanda/i, "kafka"],
];

export function readInfra(repo: Repo): Infra {
  const processes: ProcessEntry[] = [];
  const datastores: Datastore[] = [];
  const proxies: ProxyInfo[] = [];
  const add = (p: ProcessEntry) => {
    if (!processes.some((q) => q.file === p.file)) processes.push(p);
  };

  // docker-compose services first: they carry the best names.
  const dockerfileCmd = new Map<string, ProcessEntry["evidence"] & { file2: string }>();
  for (const cfg of repo.configFiles.filter((f) => /(^|\/)Dockerfile[^/]*$/i.test(f))) {
    const text = read(repo, cfg);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(CMD|ENTRYPOINT)\b/i.test(line)) {
        const cmd = line.replace(/^\s*(CMD|ENTRYPOINT)\s*/i, "").replace(/[[\]",]/g, " ");
        const m = RUNNER.exec(cmd);
        if (m) dockerfileCmd.set(cfg, { file: cfg, line: i + 1, file2: m[1]! });
      }
    });
  }

  for (const cfg of repo.configFiles.filter((f) => /(^|\/)(docker-)?compose\.ya?ml$/i.test(f))) {
    const text = read(repo, cfg);
    let doc: any;
    try {
      doc = parseYaml(text);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const lineOf = (name: string) => Math.max(1, lines.findIndex((l) => new RegExp(`^\\s{2}${escape(name)}:`).test(l)) + 1);
    for (const [name, svc] of Object.entries<any>(doc?.services ?? {})) {
      const evidence = { file: cfg, line: lineOf(name) };
      if (typeof svc?.image === "string") {
        const engine = ENGINES.find(([re]) => re.test(svc.image))?.[1];
        if (engine) datastores.push({ name, image: svc.image, engine, evidence });
        if (/nginx/i.test(svc.image)) continue;
      }
      const command = Array.isArray(svc?.command) ? svc.command.join(" ") : svc?.command;
      const fromCommand = typeof command === "string" ? RUNNER.exec(command)?.[1] : undefined;
      let entry = fromCommand;
      if (!entry && svc?.build) {
        const ctx = typeof svc.build === "string" ? svc.build : svc.build.context ?? ".";
        const dockerfile = typeof svc.build === "object" && svc.build.dockerfile ? svc.build.dockerfile : "Dockerfile";
        const df = path.posix.normalize(path.posix.join(path.posix.dirname(cfg), ctx, dockerfile));
        entry = dockerfileCmd.get(df)?.file2;
      }
      if (entry) add({ name, file: path.posix.normalize(entry), evidence });
    }
  }

  for (const [df, cmd] of dockerfileCmd) {
    const suffix = path.posix.basename(df).replace(/^Dockerfile\.?/i, "");
    add({ name: suffix || "app", file: path.posix.normalize(cmd.file2), evidence: { file: cmd.file, line: cmd.line } });
  }

  const pkg = repo.packageJson;
  if (pkg) {
    const pkgLines = read(repo, "package.json").split("\n");
    const lineOf = (needle: string) => Math.max(1, pkgLines.findIndex((l) => l.includes(needle)) + 1);
    for (const [script, cmd] of Object.entries<string>(pkg.scripts ?? {})) {
      if (/^(test|lint|build|migrate|seed|format|typecheck)/i.test(script)) continue;
      const m = typeof cmd === "string" ? RUNNER.exec(cmd) : null;
      if (m && !/migrat|seed/i.test(m[1]!)) {
        add({ name: script.replace(/:dev$/, ""), file: path.posix.normalize(m[1]!), evidence: { file: "package.json", line: lineOf(`"${script}"`) } });
      }
    }
    if (typeof pkg.main === "string" && /\.[cm]?[jt]s$/.test(pkg.main)) {
      add({ name: "main", file: path.posix.normalize(pkg.main), evidence: { file: "package.json", line: lineOf('"main"') } });
    }
  }

  for (const cfg of repo.configFiles.filter((f) => /\.conf$|(^|\/)nginx/i.test(f))) {
    const p = parseNginx(cfg, read(repo, cfg));
    if (p) proxies.push(p);
  }

  return { processes: processes.filter((p) => repo.lines.has(p.file)), datastores, proxies };
}

export function parseNginx(file: string, text: string): ProxyInfo | undefined {
  const lines = text.split("\n");
  const find = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const passLine = find(/\bproxy_pass\s/);
  if (passLine < 0) return undefined;
  const listenLine = find(/\blisten\s/);
  const upstreams = [...text.matchAll(/\bserver\s+([\w.-]+:\d+)/g)].map((m) => m[1]!);
  const rate = /limit_req_zone[^;]*rate=([\w/]+)/.exec(text)?.[1];
  return {
    name: "nginx",
    listen: { file, line: (listenLine >= 0 ? listenLine : passLine) + 1 },
    proxyPass: { file, line: passLine + 1 },
    upstreams,
    rateLimit: rate,
  };
}

function read(repo: Repo, rel: string): string {
  try {
    return readFileSync(path.join(repo.root, rel), "utf8");
  } catch {
    return "";
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
