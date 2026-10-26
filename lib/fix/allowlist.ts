// The static check on a patched handler: it parses, it imports only what a handler may import, it exports what the shop needs, and it does not
// reach for anything outside the handler context. A filter, not the containment: whatever passes still runs only in the sandbox child
// (sandbox.ts: empty environment, no network, no file system, no child processes, no string eval).
import ts from "typescript";

// What a handler file may import (lib/shop/events.ts is the shop's pure helper; types are erased).
export const ALLOWED_IMPORTS: Record<string, { names: readonly string[]; typeOnly: boolean }> = {
  "../lib/shop/events.ts": { names: ["bookingOf", "rank", "COMPLETED", "REFUNDED"], typeOnly: false },
  "../lib/shop/types.ts": { names: ["Handler", "HandlerContext", "BookEntry", "HandlerResult"], typeOnly: true },
};

// Globals a patch may introduce. `ctx` and everything the file declares itself is fine without being listed.
export const ALLOWED_GLOBALS = new Set(["undefined", "NaN", "Infinity", "JSON", "Object", "Array", "Math", "Number", "String", "Boolean", "Map", "Set", "Promise", "Date", "Error", "TypeError", "parseInt", "parseFloat", "isNaN", "isFinite", "console"]);

// Never acceptable, even if the bad file already had it: ways out of the handler context.
export const DENIED_NAMES = new Set(["process", "require", "module", "exports", "global", "globalThis", "eval", "Function", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Reflect", "Proxy", "WebAssembly", "SharedArrayBuffer", "Atomics", "Buffer", "constructor", "__proto__", "prototype", "__dirname", "__filename", "setImmediate", "queueMicrotask", "structuredClone", "Worker"]);

export type AllowlistProblemCode = "syntax_error" | "duplicate_binding" | "import_not_allowed" | "dynamic_import" | "denied_name" | "unknown_global" | "missing_export" | "import_meta_misuse";
export interface AllowlistProblem {
  code: AllowlistProblemCode;
  detail: string;
}

export function syntaxErrors(source: string): string[] {
  const out = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 120));
}

interface Facts {
  importedNames: string[];
  declared: Set<string>;
  referenced: Set<string>;
  propertyNames: Set<string>;
  problems: AllowlistProblem[];
  exportsNames: Set<string>;
}

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text);
  else for (const el of name.elements) if (ts.isBindingElement(el)) bindingNames(el.name, into);
}

function facts(source: string): Facts {
  const sf = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const f: Facts = { importedNames: [], declared: new Set(), referenced: new Set(), propertyNames: new Set(), problems: [], exportsNames: new Set() };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return; // erased
    if (ts.isImportDeclaration(node)) {
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "?";
      const allowed = ALLOWED_IMPORTS[spec];
      const clause = node.importClause;
      if (!allowed || !clause) f.problems.push({ code: "import_not_allowed", detail: spec.slice(0, 60) });
      else {
        const names: string[] = [];
        if (clause.name) names.push("default");
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) names.push("*");
          else for (const el of clause.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
        }
        const typeOnly = clause.isTypeOnly || (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every((e) => e.isTypeOnly));
        if (names.some((n) => !allowed.names.includes(n))) f.problems.push({ code: "import_not_allowed", detail: `${spec}: ${names.join(", ").slice(0, 60)}` });
        if (allowed.typeOnly && !typeOnly) f.problems.push({ code: "import_not_allowed", detail: `${spec}: only type imports` });
        const bind = (n: string) => {
          f.declared.add(n);
          f.importedNames.push(n);
        };
        if (clause.name) bind(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name.text);
          else for (const el of clause.namedBindings.elements) bind(el.name.text);
        }
      }
      return;
    }
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) f.problems.push({ code: "import_not_allowed", detail: "re-export or default export" });
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) f.problems.push({ code: "dynamic_import", detail: "import(...)" });
    if (ts.isMetaProperty(node)) {
      // only `export const SOURCE = import.meta.url;`
      const ok = ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === "url" && ts.isVariableDeclaration(node.parent.parent) && ts.isIdentifier(node.parent.parent.name) && node.parent.parent.name.text === "SOURCE";
      if (!ok) f.problems.push({ code: "import_meta_misuse", detail: node.getText(sf).slice(0, 40) });
      return;
    }
    if (ts.isVariableDeclaration(node)) bindingNames(node.name, f.declared);
    else if (ts.isParameter(node)) bindingNames(node.name, f.declared);
    else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) f.declared.add(node.name.text);
    else if (ts.isCatchClause(node) && node.variableDeclaration) bindingNames(node.variableDeclaration.name, f.declared);
    if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) for (const d of node.declarationList.declarations) bindingNames(d.name, f.exportsNames);
    if (ts.isFunctionDeclaration(node) && node.name && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) f.exportsNames.add(node.name.text);

    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isDeclName = (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isBindingElement(p)) && p.name === node;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isMethodDeclaration(p) && p.name === node) || (ts.isPropertyDeclaration(p) && p.name === node) || (ts.isBindingElement(p) && p.propertyName === node) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p);
      if (isPropName) f.propertyNames.add(node.text);
      else if (!isDeclName && !ts.isCatchClause(p)) f.referenced.add(node.text);
    }
    // x["constructor"] and friends
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && DENIED_NAMES.has(node.argumentExpression.text)) f.propertyNames.add(node.argumentExpression.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return f;
}

// All the names a source refers to (variables and properties), for the "already in the bad file" set.
export function referencedNames(source: string): Set<string> {
  const f = facts(source);
  return new Set([...f.referenced, ...f.propertyNames]);
}

// `known`: names the bad file already refers to. A patch may reuse them, but it may not introduce a global that is not on the list,
// and nothing on the denied list is ever acceptable.
export function checkAllowlist(source: string, known: ReadonlySet<string> = new Set()): AllowlistProblem[] {
  const syntax = syntaxErrors(source);
  if (syntax.length) return [{ code: "syntax_error", detail: syntax[0] }];
  const f = facts(source);
  const problems = [...f.problems];
  for (const name of [...f.referenced, ...f.propertyNames]) if (DENIED_NAMES.has(name)) problems.push({ code: "denied_name", detail: name });
  for (const name of f.referenced) {
    if (f.declared.has(name) || name === "ctx" || ALLOWED_GLOBALS.has(name) || DENIED_NAMES.has(name)) continue;
    if (!known.has(name)) problems.push({ code: "unknown_global", detail: name });
  }
  const seen = new Set<string>();
  for (const n of f.importedNames) {
    if (seen.has(n)) problems.push({ code: "duplicate_binding", detail: n });
    seen.add(n);
  }
  for (const name of ["handleWebhook", "SOURCE"]) if (!f.exportsNames.has(name)) problems.push({ code: "missing_export", detail: name });
  return problems;
}
