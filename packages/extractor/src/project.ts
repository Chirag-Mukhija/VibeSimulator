import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import { toPosix } from "./util.ts";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".vercel",
  "coverage", ".cache", "vendor", "tmp", ".idea", ".vscode", "__pycache__",
]);
const SKIP_FILE = /(\.d\.ts|\.min\.js|\.test\.[jt]sx?|\.spec\.[jt]sx?|\.stories\.[jt]sx?)$/;
/** Suffix for virtual JS files holding inline <script> code from an HTML file. */
export const INLINE_SCRIPT_SUFFIX = ".__inline__.js";
const MAX_FILES = 5000;

export interface Repo {
  root: string;
  project: Project;
  files: SourceFile[];
  /** Absolute path -> source file, for module resolution. */
  byPath: Map<string, SourceFile>;
  packageJson: Record<string, any> | undefined;
  /** Extra non-code files worth reading (compose, nginx, Dockerfiles), repo-relative. */
  configFiles: string[];
  tsPaths: { baseUrl: string; paths: Record<string, string[]> } | undefined;
  /** Lines of each file, for evidence snippets. Keyed by repo-relative path. */
  lines: Map<string, string[]>;
}

export function loadRepo(root: string): Repo {
  const abs = path.resolve(root);
  const codeFiles: string[] = [];
  const htmlFiles: string[] = [];
  const configFiles: string[] = [];
  walk(abs, abs, codeFiles, htmlFiles, configFiles);

  const tsPaths = readTsPaths(abs);
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      esModuleInterop: true,
      skipLibCheck: true,
      types: [],
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    },
  });

  const lines = new Map<string, string[]>();
  for (const file of codeFiles.slice(0, MAX_FILES)) {
    const text = readFileSync(file, "utf8");
    project.createSourceFile(file, text, { overwrite: true });
    lines.set(toPosix(path.relative(abs, file)), text.split("\n"));
  }
  for (const file of htmlFiles) {
    const html = readFileSync(file, "utf8");
    const script = inlineScriptText(html);
    if (script === undefined) continue;
    project.createSourceFile(file + INLINE_SCRIPT_SUFFIX, script, { overwrite: true });
    lines.set(toPosix(path.relative(abs, file)), html.split("\n"));
  }

  const files = project.getSourceFiles();
  const byPath = new Map(files.map((f) => [f.getFilePath(), f]));
  const pkgPath = path.join(abs, "package.json");
  const packageJson = existsSync(pkgPath) ? safeJson(readFileSync(pkgPath, "utf8")) : undefined;
  return { root: abs, project, files, byPath, packageJson, configFiles, tsPaths, lines };
}

/** Repo-relative POSIX path of a source file, mapping inline-script files back to their HTML. */
export function relPath(repo: Repo, file: SourceFile | string): string {
  const p = typeof file === "string" ? file : file.getFilePath();
  const real = p.endsWith(INLINE_SCRIPT_SUFFIX) ? p.slice(0, -INLINE_SCRIPT_SUFFIX.length) : p;
  return toPosix(path.relative(repo.root, real));
}

export function isInlineScript(file: SourceFile): boolean {
  return file.getFilePath().endsWith(INLINE_SCRIPT_SUFFIX);
}

function walk(dir: string, root: string, code: string[], html: string[], config: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!name.startsWith(".")) walk(full, root, code, html, config);
      continue;
    }
    if (st.size > 1_000_000) continue;
    const ext = path.extname(name).toLowerCase();
    if (CODE_EXTENSIONS.has(ext) && !SKIP_FILE.test(name)) code.push(full);
    else if (ext === ".html" || ext === ".htm") html.push(full);
    else if (/^(docker-compose|compose)\.ya?ml$|^Dockerfile|\.conf$|^nginx/i.test(name)) {
      config.push(toPosix(path.relative(root, full)));
    }
  }
}

/**
 * Keeps only the contents of classic inline <script> tags, replacing every
 * other character with a space so line and column numbers match the HTML.
 */
export function inlineScriptText(html: string): string | undefined {
  const out = html.replace(/[^\n]/g, " ").split("");
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let found = false;
  for (const m of html.matchAll(re)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/.test(attrs) || /type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue;
    const start = m.index! + m[0].indexOf(">") + 1;
    const body = m[2] ?? "";
    for (let i = 0; i < body.length; i++) out[start + i] = body[i]!;
    found = true;
  }
  return found ? out.join("") : undefined;
}

function readTsPaths(root: string): Repo["tsPaths"] {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const p = path.join(root, name);
    if (!existsSync(p)) continue;
    const parsed = ts.parseConfigFileTextToJson(p, readFileSync(p, "utf8"));
    const opts = parsed.config?.compilerOptions;
    if (opts?.paths) {
      return { baseUrl: path.resolve(root, opts.baseUrl ?? "."), paths: opts.paths };
    }
  }
  return undefined;
}

function safeJson(text: string): Record<string, any> | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
