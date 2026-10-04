import path from "node:path";
import { Node, SyntaxKind, type CallExpression, type NewExpression, type SourceFile } from "ts-morph";
import { isFunctionLike, ITERATION_METHODS, calleeMethodName, realPath, type FunctionLike } from "./values.ts";
import { camelFromBasename } from "./util.ts";

/** Declared or contextual name; undefined for anonymous functions. */
export function functionName(fn: FunctionLike): string | undefined {
  if ((Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn)) && fn.getName()) {
    return fn.getName();
  }
  const parent = fn.getParent();
  if (!parent) return undefined;
  const self: Node = fn;
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === self) return parent.getName();
  if (Node.isPropertyAssignment(parent) && parent.getInitializer() === self) return parent.getName().replace(/^["']|["']$/g, "");
  if (Node.isExportAssignment(parent)) return "default";
  // const createUser = catchAsync(async (req, res) => ...): named after the variable.
  if (Node.isCallExpression(parent) && parent.getArguments()[0] === self && !NOT_WRAPPERS.has(parent.getExpression().getText())) {
    const holder = parent.getParent();
    if (holder && Node.isVariableDeclaration(holder) && holder.getInitializer() === parent) return holder.getName();
  }
  if (Node.isBinaryExpression(parent) && parent.getRight() === self) {
    const left = parent.getLeft().getText().replace(/\s/g, "");
    if (left === "module.exports") return "default";
    const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
    if (m) return m[1];
  }
  return undefined;
}

/** Calls that take a callback but return something else (a timer id, a promise). */
const NOT_WRAPPERS = new Set(["setInterval", "setTimeout", "setImmediate", "requestAnimationFrame", "queueMicrotask", "Promise", "new Promise", "process.nextTick"]);

/** "@<line>" for anonymous functions, so keys stay stable and unique per file. */
export function functionKeyName(fn: FunctionLike): string {
  return functionName(fn) ?? `@${fn.getStartLineNumber()}`;
}

/** Human label prefix for a file: "auth.service.js" -> "authService", "worker/index.js" -> "worker". */
export function moduleLabel(file: SourceFile): string {
  const real = realPath(file);
  const base = path.basename(real).replace(/\.[^.]+$/, "");
  if (base === "index") return camelFromBasename(path.basename(path.dirname(real)));
  return camelFromBasename(base);
}

export interface CallSite {
  call: CallExpression | NewExpression;
  inLoop: boolean;
  /** The enclosing loop can return/break early (it usually stops after the first hit). */
  loopExits: boolean;
  parallel: boolean;
  errorPath: boolean;
  conditional: boolean;
  /** Source text of the innermost condition this call depends on, e.g. `status` or `!user`. */
  condition?: string;
  /** Which side of that condition: `then` runs when it holds, `else` when it doesn't (including code after an early return). */
  branch?: "then" | "else";
  /** Every enclosing condition, outermost first; the call runs only if all of them go this way. */
  path: BranchStep[];
  /** true: the caller waits for the result (await, return, a .then chain); false: fired and forgotten; undefined: can't tell. */
  awaited?: boolean;
}

/** Callbacks that run as part of the caller's own flow (not later, not on an event). */
const INLINE_CALLBACK_METHODS = new Set([...ITERATION_METHODS, "then", "catch", "finally", "sort", "all", "allSettled", "race", "any"]);

export interface BranchStep {
  condition: string;
  branch: "then" | "else";
  /**
   * The `then` side leaves early (return/throw/break/continue). With `guard`, it does nothing but
   * answer or throw (`if (!user) return res.status(404)...`), so the rest is the main path.
   */
  exits?: boolean;
  guard?: boolean;
}

interface Ctx {
  inLoop: boolean;
  loopExits: boolean;
  parallel: boolean;
  errorPath: boolean;
  conditional: boolean;
  condition?: string;
  branch?: "then" | "else";
  path: BranchStep[];
}

const BASE: Ctx = { inLoop: false, loopExits: false, parallel: false, errorPath: false, conditional: false, path: [] };
const enter = (ctx: Ctx, step: BranchStep): Ctx => ({ ...ctx, conditional: true, condition: step.condition, branch: step.branch, path: [...ctx.path, step] });
const conditionText = (n: Node) => {
  const t = n.getText().replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
};

/**
 * Calls a function body makes, in evaluation order. Nested functions are
 * skipped unless they run inline (array iteration, promise chains, IIFEs);
 * event callbacks become their own entries elsewhere.
 */
export function callSites(owner: Node): CallSite[] {
  const out: CallSite[] = [];
  const visit = (node: Node, ctx: Ctx) => {
    if (node !== owner && isFunctionLike(node)) {
      if (!runsInline(node)) return;
      const parent = node.getParent()!;
      const method = Node.isCallExpression(parent) ? calleeMethodName(parent) : undefined;
      const iter = method !== undefined && ITERATION_METHODS.has(method);
      // `const tasks = items.map((x) => work(x)); await Promise.all(tasks)`: the calls run together.
      const together = method === "map" && Node.isCallExpression(parent) && feedsPromiseAll(parent);
      node.forEachChild((c) => visit(c, { ...ctx, inLoop: ctx.inLoop || iter, parallel: ctx.parallel || together }));
      return;
    }
    // The condition itself always runs; only the branches are conditional.
    if (Node.isIfStatement(node)) {
      const cond = conditionText(node.getExpression());
      visit(node.getExpression(), ctx);
      const then = node.getThenStatement();
      const otherwise = node.getElseStatement();
      const exits = !otherwise && alwaysExits(then);
      visit(then, enter(ctx, { condition: cond, branch: "then", ...(exits ? { exits: true, guard: !doesWork(then) } : {}) }));
      if (otherwise) visit(otherwise, enter(ctx, { condition: cond, branch: "else" }));
      return;
    }
    if (Node.isConditionalExpression(node)) {
      const cond = conditionText(node.getCondition());
      visit(node.getCondition(), ctx);
      visit(node.getWhenTrue(), enter(ctx, { condition: cond, branch: "then" }));
      visit(node.getWhenFalse(), enter(ctx, { condition: cond, branch: "else" }));
      return;
    }
    if (Node.isSwitchStatement(node)) {
      visit(node.getExpression(), ctx);
      const subject = conditionText(node.getExpression());
      for (const clause of node.getClauses()) {
        const label = Node.isCaseClause(clause) ? `${subject} === ${conditionText(clause.getExpression())}` : `${subject} matches no case`;
        visitStatements(clause.getStatements(), enter(ctx, { condition: label, branch: "then" }));
      }
      return;
    }
    if (Node.isBlock(node)) {
      visitStatements(node.getStatements(), ctx);
      return;
    }
    let next = ctx;
    if (Node.isForStatement(node) || Node.isForOfStatement(node) || Node.isForInStatement(node)
      || Node.isWhileStatement(node) || Node.isDoStatement(node)) {
      next = { ...ctx, inLoop: true, loopExits: ctx.loopExits || loopReturns(node) };
    } else if (Node.isCatchClause(node)) {
      next = { ...ctx, errorPath: true };
    }
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      out.push({ call: node, ...ctx, awaited: awaitedState(node) });
      const method = calleeMethodName(node);
      const callee = node.getExpression();
      if ((method === "all" || method === "allSettled") && Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === "Promise") {
        next = { ...next, parallel: true };
      }
    }
    node.forEachChild((c) => visit(c, next));
  };
  // Statements in order; after `if (cond) { ...; return }` the rest of the block is the else-path.
  // After a guard clause (the early exit only answers or throws) that else-path is the main path,
  // marked `guard` so viewers play it by default; after an exit that did real work, it's an alternative.
  const visitStatements = (statements: Node[], ctx: Ctx) => {
    let current = ctx;
    for (const st of statements) {
      if (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) continue;
      visit(st, current);
      if (Node.isIfStatement(st) && !st.getElseStatement() && alwaysExits(st.getThenStatement())) {
        current = enter(current, { condition: conditionText(st.getExpression()), branch: "else", exits: true, guard: !doesWork(st.getThenStatement()) });
      }
    }
  };
  const body = isFunctionLike(owner) ? owner.getBody() : owner;
  if (!body) return out;
  if (Node.isSourceFile(body)) visitStatements(body.getStatements(), BASE);
  else visit(body, BASE);
  // Source order, inner calls before the outer call that starts at the same position.
  return out.sort((a, b) => a.call.getStart() - b.call.getStart() || a.call.getEnd() - b.call.getEnd());
}

/** One way a handler answers: `res.status(201).json(job)`, `res.redirect('/login')`, `next(err)`. */
export interface ResponseSite {
  /** The status code when it's a literal (201), else undefined. */
  status?: number;
  /** As written: "201", "err.status || 500", "302". */
  statusText: string;
  kind: "json" | "send" | "file" | "redirect" | "render" | "end" | "error";
  /** First argument as written, shortened: `job`, `{ error: 'type is required' }`, `'/login'`. */
  body?: string;
  line: number;
  /** The conditions under which this response is sent. */
  path: BranchStep[];
  errorPath: boolean;
}

const RESPONSE_METHODS: Record<string, ResponseSite["kind"]> = {
  json: "json", jsonp: "json", send: "send", sendStatus: "end", end: "end", sendFile: "file", download: "file", redirect: "redirect", render: "render",
};

/**
 * The responses an Express-style handler or middleware can send, with the branch each is on.
 * `res` is the response parameter (second, or third for error handlers).
 */
export function responsesOf(fn: FunctionLike): ResponseSite[] {
  const params = fn.getParameters();
  const errorHandler = params.length === 4;
  const nameAt = (i: number) => {
    const p = params[i];
    return p && Node.isParameterDeclaration(p) && Node.isIdentifier(p.getNameNode()) ? p.getName() : undefined;
  };
  const resName = nameAt(errorHandler ? 2 : 1);
  const nextName = nameAt(errorHandler ? 3 : 2);
  if (!resName) return [];
  const out: ResponseSite[] = [];
  const short = (n: Node | undefined) => (n ? truncateText(n.getText().replace(/\s+/g, " "), 70) : undefined);
  for (const site of callSites(fn)) {
    const call = site.call;
    if (!Node.isCallExpression(call)) continue;
    const callee = call.getExpression();
    // next(err): hand the error to the error-handling middleware.
    if (nextName && Node.isIdentifier(callee) && callee.getText() === nextName && call.getArguments().length > 0) {
      out.push({ statusText: "error handler", kind: "error", body: short(call.getArguments()[0]), line: call.getStartLineNumber(), path: site.path, errorPath: site.errorPath });
      continue;
    }
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const kind = RESPONSE_METHODS[callee.getName()];
    if (!kind) continue;
    // Walk res.status(x).cookie(...).json(y) back to `res`, picking up the status on the way.
    let statusArg: Node | undefined;
    let recv: Node = callee.getExpression();
    while (Node.isCallExpression(recv) && Node.isPropertyAccessExpression(recv.getExpression())) {
      const pa = recv.getExpression() as import("ts-morph").PropertyAccessExpression;
      if (pa.getName() === "status") statusArg = recv.getArguments()[0];
      recv = pa.getExpression();
    }
    if (!Node.isIdentifier(recv) || recv.getText() !== resName) continue;
    const args = call.getArguments();
    if (callee.getName() === "sendStatus") statusArg = args[0];
    // `const status = err.status || 500; res.status(status)`: show what the variable holds.
    if (statusArg && Node.isIdentifier(statusArg)) {
      const decl = statusArg.getSymbol()?.getDeclarations()[0];
      const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
      if (init && init.getText().length < 40) statusArg = init;
    }
    let statusText = statusArg ? statusArg.getText().replace(/\s+/g, " ") : kind === "redirect" ? "302" : "200";
    if (kind === "redirect" && args.length === 2) statusText = args[0]!.getText();
    const literal = /^\d{3}$/.test(statusText) ? Number(statusText) : undefined;
    const bodyArg = kind === "redirect" && args.length === 2 ? args[1] : callee.getName() === "sendStatus" ? undefined : args[0];
    out.push({ ...(literal ? { status: literal } : {}), statusText, kind, body: short(bodyArg), line: call.getStartLineNumber(), path: site.path, errorPath: site.errorPath });
  }
  return out;
}

function truncateText(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Responding, erroring and logging aren't "work": a branch made only of these is a guard clause. */
const NOT_WORK = /^(res|reply|response|ctx|next|console|logger|log)\b|(^|\.)(status|json|send|sendStatus|end|redirect|render)$|Error$/;

function doesWork(branch: Node): boolean {
  let work = false;
  branch.forEachDescendant((n, t) => {
    if (isFunctionLike(n)) {
      t.skip();
      return;
    }
    if (Node.isAwaitExpression(n)) {
      work = true;
      t.stop();
      return;
    }
    if (Node.isCallExpression(n) || Node.isNewExpression(n)) {
      const callee = n.getExpression().getText().replace(/\s+/g, "");
      if (!NOT_WORK.test(callee)) {
        work = true;
        t.stop();
      }
    }
  });
  return work;
}

/** `arr.map(...)` whose result goes into Promise.all / allSettled, directly or through a variable. */
function feedsPromiseAll(mapCall: Node): boolean {
  const isAll = (n: Node | undefined) => !!n && Node.isCallExpression(n) && /^Promise\.(all|allSettled)$/.test(n.getExpression().getText());
  const parent = mapCall.getParent();
  if (isAll(parent)) return true;
  if (parent && Node.isVariableDeclaration(parent)) {
    const name = parent.getName();
    const scope = parent.getFirstAncestor((a) => isFunctionLike(a)) ?? parent.getSourceFile();
    let found = false;
    scope.forEachDescendant((n, t) => {
      if (Node.isCallExpression(n) && isAll(n) && n.getArguments()[0]?.getText() === name) {
        found = true;
        t.stop();
      }
    });
    return found;
  }
  return false;
}

/** A branch that always leaves (return/throw, or break/continue inside a loop, as its last statement). */
function alwaysExits(st: Node): boolean {
  if (Node.isReturnStatement(st) || Node.isThrowStatement(st) || Node.isBreakStatement(st) || Node.isContinueStatement(st)) return true;
  if (Node.isBlock(st)) {
    const last = st.getStatements().at(-1);
    return !!last && alwaysExits(last);
  }
  if (Node.isIfStatement(st)) {
    const otherwise = st.getElseStatement();
    return !!otherwise && alwaysExits(st.getThenStatement()) && alwaysExits(otherwise);
  }
  return false;
}

/** Does the code wait for this call's result? Follows wrappers like (x), x!, x as T, .then/.catch chains and Promise.all. */
function awaitedState(call: Node): boolean | undefined {
  let node: Node = call;
  // `fetch(url).then(handle)` never blocks, but its result is still used: that counts as waiting.
  let handledInThen = false;
  for (let parent = node.getParent(); parent; node = parent, parent = parent.getParent()) {
    if (Node.isAwaitExpression(parent) || Node.isReturnStatement(parent)) return true;
    if (Node.isArrowFunction(parent) && parent.getBody() === node) return true;
    if (Node.isExpressionStatement(parent) || Node.isVoidExpression(parent)) return handledInThen;
    if (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isNonNullExpression(parent) || Node.isArrayLiteralExpression(parent)) continue;
    if (Node.isPropertyAccessExpression(parent) && ["then", "catch", "finally"].includes(parent.getName())) {
      const chained = parent.getParent();
      if (chained && Node.isCallExpression(chained)) {
        if (parent.getName() === "then") handledInThen = true;
        parent = chained;
        continue;
      }
    }
    if (Node.isCallExpression(parent) && parent.getArguments().includes(node as never)) {
      const callee = parent.getExpression().getText();
      if (/^Promise\.(all|allSettled|race|any)$/.test(callee)) continue;
    }
    return undefined;
  }
  return undefined;
}

function loopReturns(loop: Node): boolean {
  let found = false;
  loop.forEachDescendant((n, t) => {
    if (isFunctionLike(n)) {
      t.skip();
      return;
    }
    if (Node.isReturnStatement(n)) {
      found = true;
      t.stop();
    }
  });
  return found;
}

function runsInline(fn: Node): boolean {
  const parent = fn.getParent();
  if (!parent) return false;
  if (Node.isCallExpression(parent)) {
    if (parent.getExpression() === fn) return true; // (() => {...})()
    const method = calleeMethodName(parent);
    return method !== undefined && INLINE_CALLBACK_METHODS.has(method) && parent.getArguments().includes(fn as any);
  }
  if (Node.isParenthesizedExpression(parent)) {
    const call = parent.getParent();
    return !!call && Node.isCallExpression(call) && call.getExpression() === parent;
  }
  return false;
}

/**
 * `(text, params) => pool.query(text, params)`: a function whose whole body
 * forwards its parameters to one call. Callers can be treated as making that call.
 */
export function forwardedCall(fn: FunctionLike): CallExpression | undefined {
  const body = fn.getBody();
  if (!body) return undefined;
  let expr: Node | undefined;
  if (Node.isBlock(body)) {
    const stmts = body.getStatements();
    if (stmts.length !== 1) return undefined;
    const st = stmts[0]!;
    if (Node.isReturnStatement(st)) expr = st.getExpression();
    else if (Node.isExpressionStatement(st)) expr = st.getExpression();
  } else expr = body;
  while (expr && (Node.isAwaitExpression(expr) || Node.isParenthesizedExpression(expr))) expr = expr.getExpression();
  if (!expr || !Node.isCallExpression(expr)) return undefined;
  const params = fn.getParameters().map((p) => p.getText());
  const args = expr.getArguments().map((a) => a.getText());
  if (params.length === 0 || args.length !== params.length || args.some((a, i) => a !== params[i])) return undefined;
  return expr;
}

/** Nearest enclosing function, or the source file for top-level code. */
export function enclosingFunction(node: Node): FunctionLike | SourceFile {
  return (node.getFirstAncestor((a) => isFunctionLike(a)) as FunctionLike | undefined) ?? node.getSourceFile();
}

export function isErrorHandler(fn: FunctionLike): boolean {
  return fn.getParameters().length === 4;
}

export { SyntaxKind };
