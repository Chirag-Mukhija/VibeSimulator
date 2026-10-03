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
  if (Node.isBinaryExpression(parent) && parent.getRight() === self) {
    const left = parent.getLeft().getText().replace(/\s/g, "");
    if (left === "module.exports") return "default";
    const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
    if (m) return m[1];
  }
  return undefined;
}

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
  parallel: boolean;
  errorPath: boolean;
  conditional: boolean;
}

/** Callbacks that run as part of the caller's own flow (not later, not on an event). */
const INLINE_CALLBACK_METHODS = new Set([...ITERATION_METHODS, "then", "catch", "finally", "sort", "all", "allSettled", "race", "any"]);

interface Ctx {
  inLoop: boolean;
  parallel: boolean;
  errorPath: boolean;
  conditional: boolean;
}

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
      node.forEachChild((c) => visit(c, { ...ctx, inLoop: ctx.inLoop || iter }));
      return;
    }
    let next = ctx;
    if (Node.isForStatement(node) || Node.isForOfStatement(node) || Node.isForInStatement(node)
      || Node.isWhileStatement(node) || Node.isDoStatement(node)) {
      next = { ...ctx, inLoop: true };
    } else if (Node.isCatchClause(node)) {
      next = { ...ctx, errorPath: true };
    } else if (Node.isIfStatement(node) || Node.isConditionalExpression(node) || Node.isSwitchStatement(node)) {
      next = { ...ctx, conditional: true };
    }
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      out.push({ call: node, ...ctx });
      const method = calleeMethodName(node);
      const callee = node.getExpression();
      if ((method === "all" || method === "allSettled") && Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === "Promise") {
        next = { ...next, parallel: true };
      }
    }
    node.forEachChild((c) => visit(c, next));
  };
  const body = isFunctionLike(owner) ? owner.getBody() : owner;
  if (!body) return out;
  if (Node.isSourceFile(body)) {
    for (const st of body.getStatements()) {
      if (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) continue;
      visit(st, { inLoop: false, parallel: false, errorPath: false, conditional: false });
    }
  } else {
    visit(body, { inLoop: false, parallel: false, errorPath: false, conditional: false });
  }
  // Source order, inner calls before the outer call that starts at the same position.
  return out.sort((a, b) => a.call.getStart() - b.call.getStart() || a.call.getEnd() - b.call.getEnd());
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
