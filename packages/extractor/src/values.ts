import path from "node:path";
import { Node, SyntaxKind, type SourceFile, type CallExpression, type NewExpression } from "ts-morph";
import type { Repo } from "./project.ts";
import { packageName } from "./util.ts";

export type FunctionLike = Node & { getParameters(): Node[]; getBody(): Node | undefined };

export type HandleType =
  | "express-app"
  | "express-router"
  | "express-middleware" // a library middleware instance (express.json(), helmet(), rateLimit(...))
  | "http-server"
  | "pg-pool"
  | "pg-pooled-client"
  | "pg-client"
  | "mysql"
  | "redis-client"
  | "ws-server"
  | "ws-socket"
  | "sio-server"
  | "sio-socket"
  | "s3-client"
  | "prisma"
  | "mongoose-model"
  | "mongoose-doc"
  | "bull-queue"
  | "http-client" // axios instance
  | "sdk-client" // stripe, openai, ...
  | "supabase"
  | "drizzle"
  | "browser-ws"
  | "event-source"
  | "express-req"
  | "express-res";

export interface Handle {
  type: HandleType;
  /** Library that created it, e.g. "pg", "ioredis". */
  lib: string;
  /** Creation site. */
  created: Node;
  /** The handle this one was derived from (pool.connect(), client.duplicate()); itself for roots. */
  root: Handle;
  data: Record<string, unknown>;
}

export type Value =
  | { kind: "function"; node: FunctionLike }
  | { kind: "module"; file: SourceFile }
  | { kind: "external"; pkg: string; path: string[]; spec?: string }
  | { kind: "global"; path: string[] }
  | { kind: "object"; node: Node }
  | { kind: "handle"; handle: Handle }
  | { kind: "member"; handle: Handle; path: string[] }
  | { kind: "string"; value: string; template: boolean }
  | { kind: "collection"; decl: Node }
  | { kind: "class"; node: Node }
  /** Return value of a call into a package we have no model for. */
  | { kind: "result"; pkg: string; path: string[]; call: Node }
  | { kind: "instance"; cls: Node }
  | { kind: "choice"; options: Value[] }
  | { kind: "unknown" };

export const UNKNOWN: Value = { kind: "unknown" };

/** Library hooks the resolver calls; implemented in libraries.ts. */
export interface LibraryHooks {
  create(r: Resolver, call: CallExpression | NewExpression, callee: Value, isNew: boolean): Handle | undefined;
  callMember(r: Resolver, handle: Handle, path: string[], call: CallExpression): Value | undefined;
  member(r: Resolver, handle: Handle, path: string[]): Value | undefined;
  /** Value of a callback parameter when the callback is passed to a library call. */
  callbackParam(r: Resolver, call: CallExpression, callee: Value, fnIndex: number, paramIndex: number): Value | undefined;
}

interface ExportEntry {
  node?: Node;
  reexport?: { spec: string; from: SourceFile; name: string };
}
interface ModuleExports {
  equals?: Node;
  named: Map<string, ExportEntry>;
  star: { spec: string; from: SourceFile }[];
}

const FUNCTION_KINDS = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
]);

export function isFunctionLike(node: Node | undefined): node is FunctionLike {
  return !!node && FUNCTION_KINDS.has(node.getKind());
}

const GLOBALS = new Set([
  "fetch", "setInterval", "setTimeout", "setImmediate", "queueMicrotask", "WebSocket", "EventSource",
  "document", "window", "location", "console", "JSON", "Promise", "process", "globalThis", "navigator",
  "localStorage", "sessionStorage", "Math", "Date", "Object", "Array", "Number", "String", "Boolean",
  "Error", "Map", "Set", "Buffer", "URL", "URLSearchParams", "AbortSignal", "AbortController", "XMLHttpRequest",
]);

export class Resolver {
  private memo = new Map<Node, Value>();
  private active = new Set<Node>();
  private returnMemo = new Map<Node, Value>();
  private exportsMemo = new Map<SourceFile, ModuleExports>();
  private handleMemo = new Map<string, Handle>();
  private callIndex: (CallExpression | NewExpression)[] | undefined;
  private callersMemo = new Map<Node, (CallExpression | NewExpression)[]>();
  private assignmentIndex: Map<string, Node[]> | undefined;

  readonly repo: Repo;
  readonly hooks: LibraryHooks;

  constructor(repo: Repo, hooks: LibraryHooks) {
    this.repo = repo;
    this.hooks = hooks;
  }

  // ---------------------------------------------------------------- values

  value(node: Node | undefined): Value {
    if (!node) return UNKNOWN;
    const cached = this.memo.get(node);
    if (cached) return cached;
    if (this.active.has(node)) return UNKNOWN; // cycle
    this.active.add(node);
    let v: Value;
    try {
      v = this.compute(node);
    } finally {
      this.active.delete(node);
    }
    this.memo.set(node, v);
    return v;
  }

  private compute(node: Node): Value {
    if (Node.isParenthesizedExpression(node) || Node.isAwaitExpression(node) || Node.isNonNullExpression(node)
      || Node.isAsExpression(node) || Node.isTypeAssertion(node) || Node.isSatisfiesExpression(node)) {
      return this.value(node.getExpression());
    }
    if (Node.isIdentifier(node)) return this.identifier(node);
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      return { kind: "string", value: node.getLiteralText(), template: false };
    }
    if (Node.isTemplateExpression(node)) return { kind: "string", value: templatePattern(node), template: true };
    if (Node.isBinaryExpression(node)) return this.binary(node);
    if (Node.isConditionalExpression(node)) {
      return choice([this.value(node.getWhenTrue()), this.value(node.getWhenFalse())]);
    }
    if (isFunctionLike(node)) return { kind: "function", node };
    if (Node.isThisExpression(node)) {
      const cls = node.getFirstAncestor((a) => Node.isClassDeclaration(a) || Node.isClassExpression(a));
      return cls ? { kind: "instance", cls } : UNKNOWN;
    }
    if (Node.isClassExpression(node)) return { kind: "class", node };
    if (Node.isObjectLiteralExpression(node)) return { kind: "object", node };
    if (Node.isArrayLiteralExpression(node)) return { kind: "collection", decl: node };
    if (Node.isPropertyAccessExpression(node)) return this.member(this.value(node.getExpression()), node.getName());
    if (Node.isElementAccessExpression(node)) {
      const arg = node.getArgumentExpression();
      const key = arg ? this.value(arg) : UNKNOWN;
      const base = this.value(node.getExpression());
      if (key.kind === "string" && !key.template) return this.member(base, key.value);
      return this.dynamicMember(base);
    }
    if (Node.isCallExpression(node)) return this.call(node);
    if (Node.isNewExpression(node)) return this.newExpr(node);
    return UNKNOWN;
  }

  private binary(node: Node & { getOperatorToken(): Node; getLeft(): Node; getRight(): Node }): Value {
    const op = node.getOperatorToken().getKind();
    if (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) {
      return choice([this.value(node.getLeft()), this.value(node.getRight())]);
    }
    if (op === SyntaxKind.PlusToken) {
      const l = this.value(node.getLeft());
      const r = this.value(node.getRight());
      const ls = l.kind === "string" ? l.value : "{}";
      const rs = r.kind === "string" ? r.value : "{}";
      if (l.kind === "string" || r.kind === "string") {
        return { kind: "string", value: ls + rs, template: l.kind !== "string" || r.kind !== "string" || (l.kind === "string" && l.template) || (r.kind === "string" && r.template) };
      }
    }
    if (op === SyntaxKind.EqualsToken) return this.value(node.getRight());
    return UNKNOWN;
  }

  private identifier(id: Node): Value {
    const name = id.getText();
    if (name === "undefined") return UNKNOWN;
    const decl = this.declarationOf(id);
    if (!decl) return GLOBALS.has(name) ? { kind: "global", path: [name] } : UNKNOWN;
    if (decl.getSourceFile().isDeclarationFile() || decl.getSourceFile().isInNodeModules()) {
      return { kind: "global", path: [name] };
    }
    return this.declaration(decl);
  }

  /** Local declaration of an identifier via the type checker's scope resolution. */
  declarationOf(id: Node): Node | undefined {
    let symbol;
    try {
      symbol = id.getSymbol();
    } catch {
      return undefined;
    }
    const decl = symbol?.getDeclarations()[0];
    if (decl && Node.isShorthandPropertyAssignment(decl)) {
      return decl.getValueSymbol()?.getDeclarations()[0] ?? decl;
    }
    return decl;
  }

  declaration(decl: Node): Value {
    if (Node.isVariableDeclaration(decl)) {
      const forOf = decl.getParent()?.getParent();
      if (forOf && Node.isForOfStatement(forOf)) return this.elementOf(this.value(forOf.getExpression()));
      const init = decl.getInitializer();
      const initValue = init && !Node.isNullLiteral(init) ? this.value(init) : UNKNOWN;
      if (initValue.kind !== "unknown") {
        if (initValue.kind === "collection") return { kind: "collection", decl };
        return initValue;
      }
      return this.assignedValue(decl);
    }
    if (Node.isBindingElement(decl)) return this.bindingElement(decl);
    if (isFunctionLike(decl)) return { kind: "function", node: decl };
    if (Node.isClassDeclaration(decl)) return { kind: "class", node: decl };
    if (Node.isParameterDeclaration(decl)) return this.parameter(decl);
    if (Node.isImportSpecifier(decl)) {
      const imp = decl.getImportDeclaration();
      return this.member(this.moduleValue(imp.getModuleSpecifierValue(), decl.getSourceFile()), decl.getName());
    }
    if (Node.isImportClause(decl)) {
      const imp = decl.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration);
      return this.member(this.moduleValue(imp.getModuleSpecifierValue(), decl.getSourceFile()), "default");
    }
    if (Node.isNamespaceImport(decl)) {
      const imp = decl.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration);
      return this.moduleValue(imp.getModuleSpecifierValue(), decl.getSourceFile(), true);
    }
    if (Node.isImportEqualsDeclaration(decl)) {
      const ref = decl.getModuleReference();
      if (Node.isExternalModuleReference(ref)) {
        const expr = ref.getExpression();
        if (expr && Node.isStringLiteral(expr)) return this.moduleValue(expr.getLiteralText(), decl.getSourceFile());
      }
      return UNKNOWN;
    }
    if (Node.isPropertyAssignment(decl)) return this.value(decl.getInitializer());
    return UNKNOWN;
  }

  /** `let x = null; ... x = createThing()` — union of every assignment to the variable. */
  private assignedValue(decl: Node & { getName(): string }): Value {
    const assignments = this.assignments().get(decl.getName()) ?? [];
    const values: Value[] = [];
    for (const right of assignments) {
      const bin = right.getParent()!;
      const left = (bin as any).getLeft() as Node;
      if (this.declarationOf(left) !== decl) continue;
      values.push(this.value(right));
    }
    return choice(values);
  }

  private assignments(): Map<string, Node[]> {
    if (this.assignmentIndex) return this.assignmentIndex;
    const index = new Map<string, Node[]>();
    for (const file of this.repo.files) {
      file.forEachDescendant((n) => {
        if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
          const left = n.getLeft();
          if (Node.isIdentifier(left)) {
            const list = index.get(left.getText()) ?? [];
            list.push(n.getRight());
            index.set(left.getText(), list);
          }
        }
      });
    }
    this.assignmentIndex = index;
    return index;
  }

  private bindingElement(decl: Node & { getPropertyNameNode(): Node | undefined; getNameNode(): Node }): Value {
    const key = (decl.getPropertyNameNode() ?? decl.getNameNode()).getText();
    const pattern = decl.getParent()!;
    if (Node.isArrayBindingPattern(pattern)) return UNKNOWN;
    const owner = pattern.getParent()!;
    let base: Value = UNKNOWN;
    if (Node.isVariableDeclaration(owner)) {
      const forOf = owner.getParent()?.getParent();
      base = forOf && Node.isForOfStatement(forOf) ? this.elementOf(this.value(forOf.getExpression())) : this.value(owner.getInitializer());
    } else if (Node.isParameterDeclaration(owner)) base = this.parameter(owner);
    else if (Node.isBindingElement(owner)) base = this.bindingElement(owner as any);
    return this.member(base, key);
  }

  private parameter(param: Node): Value {
    const fn = param.getParent();
    if (fn && Node.isConstructorDeclaration(fn)) {
      const index = fn.getParameters().indexOf(param as any);
      const cls = fn.getParent();
      return choice(this.instantiations(cls).map((n) => this.value(n.getArguments()[index])));
    }
    if (!isFunctionLike(fn)) return UNKNOWN;
    const index = fn.getParameters().indexOf(param);
    // Callback passed straight to a call: library semantics first, then user functions.
    const parent = fn.getParent();
    if (parent && Node.isCallExpression(parent) && parent.getArguments().includes(fn as any)) {
      const callee = this.value(parent.getExpression());
      const fnIndex = parent.getArguments().indexOf(fn as any);
      const lib = this.hooks.callbackParam(this, parent, callee, fnIndex, index);
      if (lib) return lib;
      // Array iteration: element of the receiver collection.
      const method = calleeMethodName(parent);
      if (index === 0 && method && ITERATION_METHODS.has(method)) {
        const recv = (parent.getExpression() as any).getExpression?.() as Node | undefined;
        return this.elementOf(this.value(recv));
      }
      // cache(fn) / asyncHandler(fn): the wrapped function is called by whoever calls the wrapper's result.
      const wrapped = pick(this.value(parent), "function");
      if (wrapped?.node !== fn) return UNKNOWN;
    }
    const values = this.callersOf(fn).map((call) => this.value(call.getArguments()[index]));
    return choice(values);
  }

  private call(call: CallExpression): Value {
    const calleeNode = call.getExpression();
    if (Node.isIdentifier(calleeNode) && calleeNode.getText() === "require") {
      const arg = call.getArguments()[0];
      if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
        return this.moduleValue(arg.getLiteralText(), call.getSourceFile());
      }
      return UNKNOWN;
    }
    // x.then(cb): the promise resolves to cb's return value.
    if (Node.isPropertyAccessExpression(calleeNode) && calleeNode.getName() === "then") {
      const cb = call.getArguments()[0];
      if (cb && isFunctionLike(cb)) return this.returnValue(cb);
      return this.value(calleeNode.getExpression());
    }
    const callee = this.value(calleeNode);
    const created = this.hooks.create(this, call, callee, false);
    if (created) return { kind: "handle", handle: created };
    if (callee.kind === "member") return this.hooks.callMember(this, callee.handle, callee.path, call) ?? UNKNOWN;
    if (callee.kind === "external") {
      // cache(fn), unstable_cache(fn), asyncHandler(fn), debounce(fn): a library
      // higher-order function hands back a wrapped version of the function.
      const first = call.getArguments()[0];
      const fn = first ? pick(this.value(first), "function") : undefined;
      if (fn) return fn;
      return { kind: "result", pkg: callee.pkg, path: callee.path, call };
    }
    if (callee.kind === "function") return this.returnValue(callee.node);
    if (callee.kind === "choice") {
      return choice(callee.options.map((o) => (o.kind === "function" ? this.returnValue(o.node) : UNKNOWN)));
    }
    return UNKNOWN;
  }

  private newExpr(node: NewExpression): Value {
    const calleeNode = node.getExpression();
    const name = calleeNode.getText();
    if (name === "Set" || name === "Map" || name === "WeakMap" || name === "WeakSet" || name === "Array") {
      return { kind: "collection", decl: node };
    }
    const callee = this.value(calleeNode);
    const created = this.hooks.create(this, node, callee, true);
    if (created) return { kind: "handle", handle: created };
    const cls = pick(callee, "class");
    if (cls) return { kind: "instance", cls: cls.node };
    return UNKNOWN;
  }

  /**
   * The expression a name was defined as, following identifiers, object
   * properties and module exports: `userController.createUser` ->
   * `catchAsync(async (req, res) => ...)`.
   */
  originOf(expr: Node, depth = 0): Node {
    if (depth > 12) return expr;
    if (Node.isParenthesizedExpression(expr) || Node.isAsExpression(expr) || Node.isNonNullExpression(expr)) {
      return this.originOf(expr.getExpression(), depth + 1);
    }
    if (Node.isIdentifier(expr)) {
      const d = this.declarationOf(expr);
      if (d && Node.isVariableDeclaration(d) && d.getInitializer() && !d.getParent()?.getParent()?.isKind(SyntaxKind.ForOfStatement)) {
        return this.originOf(d.getInitializer()!, depth + 1);
      }
      if (d && Node.isBindingElement(d)) {
        const owner = d.getParent()?.getParent();
        if (owner && Node.isVariableDeclaration(owner) && owner.getInitializer()) {
          const key = (d.getPropertyNameNode() ?? d.getNameNode()).getText();
          const found = this.propertyOrigin(this.value(owner.getInitializer()!), key, depth);
          if (found) return found;
        }
      }
      if (d && (Node.isImportSpecifier(d) || Node.isImportClause(d))) {
        const imp = d.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration);
        const file = this.resolveModule(imp.getModuleSpecifierValue(), d.getSourceFile());
        const name = Node.isImportSpecifier(d) ? d.getName() : "default";
        const found = file ? this.exportOrigin(file, name, depth) : undefined;
        if (found) return found;
      }
      return expr;
    }
    if (Node.isPropertyAccessExpression(expr)) {
      const found = this.propertyOrigin(this.value(expr.getExpression()), expr.getName(), depth);
      if (found) return found;
    }
    return expr;
  }

  private propertyOrigin(base: Value, key: string, depth: number): Node | undefined {
    if (base.kind === "object") {
      for (const p of (base.node as any).getProperties() as Node[]) {
        if (Node.isPropertyAssignment(p) && propName(p) === key) return this.originOf(p.getInitializerOrThrow(), depth + 1);
        if (Node.isShorthandPropertyAssignment(p) && p.getName() === key) return this.originOf(p.getNameNode(), depth + 1);
      }
    }
    if (base.kind === "module") return this.exportOrigin(base.file, key, depth);
    return undefined;
  }

  private exportOrigin(file: SourceFile, name: string, depth: number): Node | undefined {
    const ex = this.moduleExports(file);
    const entry = ex.named.get(name);
    if (entry?.node) {
      const n = entry.node;
      if (Node.isVariableDeclaration(n)) return n.getInitializer() ? this.originOf(n.getInitializer()!, depth + 1) : undefined;
      return isDeclarationNode(n) ? n : this.originOf(n, depth + 1);
    }
    if (ex.equals) return this.propertyOrigin(this.value(ex.equals), name, depth);
    return undefined;
  }

  /** `new Cls(...)` expressions for a class. */
  instantiations(cls: Node): NewExpression[] {
    const name = (cls as any).getName?.() as string | undefined;
    return this.calls().filter((c): c is NewExpression => {
      if (!Node.isNewExpression(c)) return false;
      if (name && !c.getExpression().getText().endsWith(name)) return false;
      const v = pick(this.value(c.getExpression()), "class");
      return v?.node === cls;
    });
  }

  private classMember(cls: Node, name: string, isStatic: boolean): Value {
    for (const m of (cls as any).getMembers() as Node[]) {
      const st = (m as any).isStatic?.() ?? false;
      if (st !== isStatic) continue;
      if (Node.isMethodDeclaration(m) && m.getName() === name) return { kind: "function", node: m as FunctionLike };
      if (Node.isPropertyDeclaration(m) && m.getName() === name) {
        const init = m.getInitializer();
        if (init) return this.value(init);
      }
      if (Node.isGetAccessorDeclaration(m) && m.getName() === name) return this.returnValue(m as unknown as FunctionLike);
    }
    if (!isStatic) {
      const ctor = (cls as any).getConstructors?.()[0] as Node | undefined;
      if (ctor && Node.isConstructorDeclaration(ctor)) {
        for (const p of ctor.getParameters()) {
          if (p.isParameterProperty() && p.getName() === name) return this.parameter(p);
        }
        const values: Value[] = [];
        ctor.getBody()?.forEachDescendant((n) => {
          if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.EqualsToken
            && n.getLeft().getText().replace(/\s/g, "") === `this.${name}`) values.push(this.value(n.getRight()));
        });
        if (values.length) return choice(values);
      }
    }
    const base = (cls as any).getExtends?.()?.getExpression() as Node | undefined;
    if (base) {
      const b = this.value(base);
      if (b.kind === "class") return this.classMember(b.node, name, isStatic);
    }
    return UNKNOWN;
  }

  returnValue(fn: FunctionLike): Value {
    const cached = this.returnMemo.get(fn);
    if (cached) return cached;
    if (this.active.has(fn)) return UNKNOWN;
    this.active.add(fn);
    let result: Value;
    try {
      const body = fn.getBody();
      if (!body) result = UNKNOWN;
      else if (!Node.isBlock(body)) result = this.value(body);
      else {
        const values: Value[] = [];
        body.forEachDescendant((n, t) => {
          if (isFunctionLike(n)) {
            t.skip();
            return;
          }
          if (Node.isReturnStatement(n)) values.push(this.value(n.getExpression()));
        });
        result = choice(values);
      }
    } finally {
      this.active.delete(fn);
    }
    this.returnMemo.set(fn, result);
    return result;
  }

  member(base: Value, name: string): Value {
    switch (base.kind) {
      case "module":
        return this.moduleMember(base.file, name);
      case "external":
        return name === "default" ? base : { kind: "external", pkg: base.pkg, path: [...base.path, name], spec: base.spec };
      case "global":
        return { kind: "global", path: [...base.path, name] };
      case "object":
        return this.objectMember(base.node, name);
      case "handle":
        return this.hooks.member(this, base.handle, [name]) ?? { kind: "member", handle: base.handle, path: [name] };
      case "member": {
        const path = [...base.path, name];
        return this.hooks.member(this, base.handle, path) ?? { kind: "member", handle: base.handle, path };
      }
      case "choice":
        return choice(base.options.map((o) => this.member(o, name)));
      case "instance":
        return this.classMember(base.cls, name, false);
      case "class":
        return this.classMember(base.node, name, true);
      default:
        return UNKNOWN;
    }
  }

  /** obj[key] with a non-constant key: any of the object's values. */
  private dynamicMember(base: Value): Value {
    if (base.kind === "object") {
      const values: Value[] = [];
      for (const prop of (base.node as any).getProperties() as Node[]) {
        if (Node.isPropertyAssignment(prop)) values.push(this.value(prop.getInitializer()));
        else if (Node.isShorthandPropertyAssignment(prop)) values.push(this.value(prop.getNameNode()));
        else if (Node.isMethodDeclaration(prop)) values.push({ kind: "function", node: prop as FunctionLike });
      }
      return values.length ? { kind: "choice", options: values } : UNKNOWN;
    }
    if (base.kind === "collection") return this.elementOf(base);
    return UNKNOWN;
  }

  private objectMember(obj: Node, name: string): Value {
    const props = (obj as any).getProperties() as Node[];
    for (const prop of [...props].reverse()) {
      if (Node.isPropertyAssignment(prop) && propName(prop) === name) return this.value(prop.getInitializer());
      if (Node.isShorthandPropertyAssignment(prop) && prop.getName() === name) return this.value(prop.getNameNode());
      if (Node.isMethodDeclaration(prop) && prop.getName() === name) return { kind: "function", node: prop as FunctionLike };
      if (Node.isSpreadAssignment(prop)) {
        const v = this.member(this.value(prop.getExpression()), name);
        if (v.kind !== "unknown") return v;
      }
    }
    return UNKNOWN;
  }

  /** Values put into a collection with add/push/set, or ws-server `clients`. */
  elementOf(coll: Value): Value {
    if (coll.kind === "member" || coll.kind === "handle") {
      return this.hooks.member(this, coll.kind === "member" ? coll.handle : coll.handle, [
        ...(coll.kind === "member" ? coll.path : []),
        "[element]",
      ]) ?? UNKNOWN;
    }
    if (coll.kind !== "collection") return UNKNOWN;
    const decl = coll.decl;
    const values: Value[] = [];
    if (Node.isArrayLiteralExpression(decl)) {
      for (const el of decl.getElements()) values.push(this.value(el));
      return choice(values);
    }
    for (const call of this.calls()) {
      if (!Node.isCallExpression(call)) continue;
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const method = callee.getName();
      if (method !== "add" && method !== "push" && method !== "set" && method !== "unshift") continue;
      const recv = this.value(callee.getExpression());
      if (recv.kind !== "collection" || recv.decl !== decl) continue;
      const arg = call.getArguments()[method === "set" ? 1 : 0];
      values.push(this.value(arg));
    }
    return choice(values);
  }

  // --------------------------------------------------------------- modules

  moduleValue(spec: string, from: SourceFile, namespace = false): Value {
    const file = this.resolveModule(spec, from);
    if (!file) return { kind: "external", pkg: packageName(spec), path: [], spec };
    if (!namespace) {
      const ex = this.moduleExports(file);
      if (ex.equals) return this.value(ex.equals);
    }
    return { kind: "module", file };
  }

  resolveModule(spec: string, from: SourceFile): SourceFile | undefined {
    const candidates: string[] = [];
    if (spec.startsWith(".") || spec.startsWith("/")) {
      candidates.push(path.resolve(path.dirname(realPath(from)), spec));
    } else if (this.repo.tsPaths) {
      for (const [pattern, targets] of Object.entries(this.repo.tsPaths.paths)) {
        const prefix = pattern.replace(/\*$/, "");
        if (pattern.endsWith("*") ? spec.startsWith(prefix) : spec === pattern) {
          const rest = spec.slice(prefix.length);
          for (const t of targets) candidates.push(path.resolve(this.repo.tsPaths.baseUrl, t.replace(/\*$/, "") + rest));
        }
      }
    }
    for (const base of candidates) {
      const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
      for (const p of [base, ...EXTS.map((e) => stripped + e), ...EXTS.map((e) => path.join(base, "index" + e))]) {
        const file = this.repo.byPath.get(p);
        if (file) return file;
      }
    }
    return undefined;
  }

  moduleExports(file: SourceFile): ModuleExports {
    const cached = this.exportsMemo.get(file);
    if (cached) return cached;
    const ex: ModuleExports = { named: new Map(), star: [] };
    this.exportsMemo.set(file, ex);
    for (const st of file.getStatements()) {
      if (Node.isExpressionStatement(st)) {
        const e = st.getExpression();
        if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
          const left = e.getLeft().getText().replace(/\s/g, "");
          if (left === "module.exports") ex.equals = e.getRight();
          else {
            const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
            if (m) ex.named.set(m[1]!, { node: e.getRight() });
          }
        }
      } else if (Node.isExportAssignment(st)) {
        if (st.isExportEquals()) ex.equals = st.getExpression();
        else ex.named.set("default", { node: st.getExpression() });
      } else if (Node.isExportDeclaration(st)) {
        const spec = st.getModuleSpecifierValue();
        const from = spec ? this.resolveModule(spec, file) : undefined;
        if (!st.hasNamedExports()) {
          if (spec && from) ex.star.push({ spec, from });
          continue;
        }
        for (const s of st.getNamedExports()) {
          const exported = s.getAliasNode()?.getText() ?? s.getName();
          if (spec) {
            ex.named.set(exported, { reexport: { spec, from: from ?? file, name: s.getName() } });
          } else {
            const local = findTopLevel(file, s.getName());
            if (local) ex.named.set(exported, { node: local });
          }
        }
      } else if (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) {
        if (st.isExported()) ex.named.set(st.isDefaultExport() ? "default" : st.getName() ?? "default", { node: st });
      } else if (Node.isVariableStatement(st) && st.isExported()) {
        for (const d of st.getDeclarations()) ex.named.set(d.getName(), { node: d });
      }
    }
    return ex;
  }

  private moduleMember(file: SourceFile, name: string): Value {
    const ex = this.moduleExports(file);
    const entry = ex.named.get(name);
    if (entry?.node) {
      return isDeclarationNode(entry.node) ? this.declaration(entry.node) : this.value(entry.node);
    }
    if (entry?.reexport) {
      const target = this.resolveModule(entry.reexport.spec, entry.reexport.from);
      return target
        ? this.moduleMember(target, entry.reexport.name)
        : { kind: "external", pkg: packageName(entry.reexport.spec), path: [entry.reexport.name] };
    }
    if (ex.equals) {
      const eq = this.value(ex.equals);
      return name === "default" ? eq : this.member(eq, name);
    }
    for (const star of ex.star) {
      const v = this.moduleMember(star.from, name);
      if (v.kind !== "unknown") return v;
    }
    return UNKNOWN;
  }

  // ----------------------------------------------------------------- calls

  /** Every call and `new` expression in the repo. */
  calls(): (CallExpression | NewExpression)[] {
    if (this.callIndex) return this.callIndex;
    const out: (CallExpression | NewExpression)[] = [];
    for (const file of this.repo.files) {
      file.forEachDescendant((n) => {
        if (Node.isCallExpression(n) || Node.isNewExpression(n)) out.push(n);
      });
    }
    this.callIndex = out;
    return out;
  }

  /** Call sites whose callee resolves to `fn`. */
  callersOf(fn: Node): (CallExpression | NewExpression)[] {
    const cached = this.callersMemo.get(fn);
    if (cached) return cached;
    this.callersMemo.set(fn, []);
    const name = functionNameHint(fn);
    const result = this.calls().filter((call) => {
      if (!Node.isCallExpression(call)) return false;
      const expr = call.getExpression();
      // Cheap name filter before resolving.
      const text = Node.isPropertyAccessExpression(expr) ? expr.getName() : expr.getText();
      if (name && text !== name) return false;
      const v = this.value(expr);
      return v.kind === "function" ? v.node === fn : v.kind === "choice" && v.options.some((o) => o.kind === "function" && o.node === fn);
    });
    this.callersMemo.set(fn, result);
    return result;
  }

  /** One Handle object per creation site, so identity comparisons work. */
  handle(key: string, make: () => Handle): Handle {
    let h = this.handleMemo.get(key);
    if (!h) {
      h = make();
      this.handleMemo.set(key, h);
    }
    return h;
  }

  allHandles(): Handle[] {
    return [...this.handleMemo.values()];
  }
}

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
export const ITERATION_METHODS = new Set(["forEach", "map", "filter", "reduce", "some", "every", "find", "findIndex", "flatMap"]);

export function choice(values: Value[]): Value {
  const known: Value[] = [];
  for (const v of values) {
    const flat = v.kind === "choice" ? v.options : [v];
    for (const f of flat) if (f.kind !== "unknown" && !known.some((k) => sameValue(k, f))) known.push(f);
  }
  if (known.length === 0) return UNKNOWN;
  return known.length === 1 ? known[0]! : { kind: "choice", options: known };
}

function sameValue(a: Value, b: Value): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "function": return a.node === (b as typeof a).node;
    case "handle": return a.handle === (b as typeof a).handle;
    case "object": return a.node === (b as typeof a).node;
    case "module": return a.file === (b as typeof a).file;
    case "collection": return a.decl === (b as typeof a).decl;
    case "class": return a.node === (b as typeof a).node;
    case "instance": return a.cls === (b as typeof a).cls;
    case "result": return a.call === (b as typeof a).call;
    case "member": return a.handle === (b as typeof a).handle && a.path.join(".") === (b as typeof a).path.join(".");
    case "global": return a.path.join(".") === (b as typeof a).path.join(".");
    case "string": return a.value === (b as typeof a).value;
    case "external": return a.pkg === (b as typeof a).pkg && a.path.join(".") === (b as typeof a).path.join(".");
    default: return false;
  }
}

/** First option of a given kind, looking through choices. */
export function pick<K extends Value["kind"]>(v: Value, kind: K): Extract<Value, { kind: K }> | undefined {
  if (v.kind === kind) return v as Extract<Value, { kind: K }>;
  if (v.kind === "choice") return v.options.find((o) => o.kind === kind) as Extract<Value, { kind: K }> | undefined;
  return undefined;
}

export function calleeMethodName(call: CallExpression | NewExpression): string | undefined {
  const e = call.getExpression();
  return Node.isPropertyAccessExpression(e) ? e.getName() : Node.isIdentifier(e) ? e.getText() : undefined;
}

function propName(prop: Node & { getName(): string }): string {
  return prop.getName().replace(/^["']|["']$/g, "");
}

function templatePattern(node: Node & { getHead(): Node; getTemplateSpans(): Node[] }): string {
  let out = (node.getHead() as any).getLiteralText();
  for (const span of node.getTemplateSpans()) out += "{}" + (span as any).getLiteral().getLiteralText();
  return out;
}

function isDeclarationNode(n: Node): boolean {
  return Node.isVariableDeclaration(n) || Node.isFunctionDeclaration(n) || Node.isClassDeclaration(n);
}

function findTopLevel(file: SourceFile, name: string): Node | undefined {
  return file.getFunction(name) ?? file.getVariableDeclaration(name) ?? file.getClass(name);
}

function functionNameHint(fn: Node): string | undefined {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName();
  const parent = fn.getParent();
  if (parent && Node.isCallExpression(parent)) {
    const holder = parent.getParent();
    if (holder && Node.isVariableDeclaration(holder)) return holder.getName();
  }
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
  return undefined;
}

export function realPath(file: SourceFile): string {
  return file.getFilePath().replace(/\.__inline__\.js$/, "");
}
