import { existsSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Node, Project, SyntaxKind, type CallExpression, type NewExpression, type ParameterDeclaration, type SourceFile } from 'ts-morph';

// Static evaluation with ts-morph (PLAN.md Phase 2 resolution). Nothing is executed: values are followed through
// constants, imports, class properties, object members, loops over literal arrays, function parameters (to their
// callers) and function returns. Anything else stays unknown rather than guessed.

// What names are bound to in one evaluation: a loop variable to one element, a parameter to one argument.
export type Env = ReadonlyMap<string, Node>;
export const NO_ENV: Env = new Map();

const MAX_DEPTH = 16;
const LOOP_METHODS = new Set(['forEach', 'map', 'flatMap']);

export const keyOf = (node: Node): string => `${node.getSourceFile().getFilePath()}:${node.getStart()}:${node.getEnd()}:${node.getKind()}`;

export const isFunctionLike = (node: Node): boolean =>
  Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node);

const isImport = (node: Node): boolean =>
  Node.isImportSpecifier(node) || Node.isImportClause(node) || Node.isNamespaceImport(node) || Node.isImportEqualsDeclaration(node);

// Project code, as opposed to a library: not an unresolved import and not a declaration from node_modules.
export const inProject = (node: Node): boolean => !isImport(node) && !node.getSourceFile().getFilePath().includes('/node_modules/') && !node.getSourceFile().isDeclarationFile();

function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) || Node.isAsExpression(current) || Node.isSatisfiesExpression(current) ||
    Node.isNonNullExpression(current) || Node.isTypeAssertion(current) || Node.isAwaitExpression(current)
  ) current = current.getExpression();
  return current;
}

// The module and imported name behind a local identifier: import { Router } from 'express' -> express, Router.
// Uses the local symbol, not its definition, so it works whether or not node_modules is installed.
export function importOf(identifier: Node): { module: string; name: string } | undefined {
  const declaration = identifier.getSymbol()?.getDeclarations()[0];
  if (Node.isImportSpecifier(declaration)) return { module: declaration.getImportDeclaration().getModuleSpecifierValue(), name: declaration.getName() };
  const importDeclaration = declaration?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  if (Node.isImportClause(declaration) && importDeclaration) return { module: importDeclaration.getModuleSpecifierValue(), name: 'default' };
  if (Node.isNamespaceImport(declaration) && importDeclaration) return { module: importDeclaration.getModuleSpecifierValue(), name: '*' };
  const required = (holder: Node | undefined) => {
    const call = Node.isVariableDeclaration(holder) ? holder.getInitializer() : undefined;
    const [specifier] = Node.isCallExpression(call) && call.getExpression().getText() === 'require' ? call.getArguments() : [];
    return Node.isStringLiteral(specifier) ? specifier.getLiteralValue() : undefined;
  };
  if (Node.isVariableDeclaration(declaration)) {
    const module = required(declaration);
    return module === undefined ? undefined : { module, name: '*' };
  }
  if (Node.isBindingElement(declaration)) {
    const module = required(declaration.getParentOrThrow().getParent());
    return module === undefined ? undefined : { module, name: (declaration.getPropertyNameNode() ?? declaration.getNameNode()).getText() };
  }
  return undefined;
}

// The declaration that names a value: `const ok = (...) => ...` names the arrow function, a class property names
// its initializer. A value written inline (an arrow passed straight to a call) is its own declaration.
export function holderOf(value: Node): Node {
  const parent = value.getParent();
  const holds = Node.isVariableDeclaration(parent) || Node.isPropertyDeclaration(parent) || Node.isPropertyAssignment(parent);
  return holds && parent.getInitializer() === value ? parent : value;
}

// A readable name for a declaration: "register", "orders.list", "AdminController.stats".
export function qualifiedName(declaration: Node): string | undefined {
  const own = Node.hasName(declaration) ? declaration.getName() : undefined;
  if (own === undefined) return undefined;
  const container = declaration.getParent();
  if (Node.isClassDeclaration(container)) return `${container.getName() ?? 'class'}.${own}`;
  if (Node.isObjectLiteralExpression(container)) {
    const holder = container.getParent();
    return Node.isVariableDeclaration(holder) ? `${holder.getName()}.${own}` : own;
  }
  return own;
}

// What `this` means at a node: the class, or the object literal a method belongs to. Arrow functions see through.
function thisOwner(node: Node): Node | undefined {
  for (let current = node.getParent(); current !== undefined; current = current.getParent()) {
    if (Node.isClassDeclaration(current) || Node.isClassExpression(current)) return current;
    if (Node.isMethodDeclaration(current) && Node.isObjectLiteralExpression(current.getParent())) return current.getParent();
    if (Node.isFunctionDeclaration(current) || Node.isFunctionExpression(current)) return undefined;
  }
  return undefined;
}

function returnsOf(fn: Node): Node[] {
  if (Node.isArrowFunction(fn) && !Node.isBlock(fn.getBody())) return [fn.getBody()];
  return fn
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((statement) => statement.getFirstAncestor(isFunctionLike) === fn)
    .flatMap((statement) => statement.getExpression() ?? []);
}

export class Resolver {
  private readonly project: Project;
  private readonly dir: string;
  private readonly sources: ReadonlyMap<string, string>;
  private readonly loaded = new Set<string>();

  // `sources` holds every source file in the repo (relative path -> text); files are loaded only when needed.
  constructor(dir: string, sources: ReadonlyMap<string, string>) {
    // Everything goes through the real path, tsconfig included: ts-morph reports real paths, and a tsconfig read through
    // a symlink would resolve path aliases to a second copy of each file (macOS's /tmp and /var are symlinks).
    this.dir = realpathSync(dir);
    this.sources = sources;
    const tsconfig = join(this.dir, 'tsconfig.json');
    const compilerOptions = { allowJs: true, noEmit: true };
    let project: Project;
    try {
      project = new Project({ tsConfigFilePath: existsSync(tsconfig) ? tsconfig : undefined, skipAddingFilesFromTsConfig: true, compilerOptions });
    } catch {
      project = new Project({ compilerOptions }); // an unreadable tsconfig only costs path aliases
    }
    this.project = project;
  }

  file(path: string): SourceFile {
    const absolute = join(this.dir, path);
    this.loaded.add(path);
    return this.project.getSourceFile(absolute) ?? this.project.addSourceFileAtPath(absolute);
  }

  // Evidence for a node: its file relative to the repo, and the line of its name (or of its start).
  where(node: Node): { file: string; line: number } {
    const name = node.getFirstChildByKind(SyntaxKind.Identifier);
    return { file: relative(this.dir, node.getSourceFile().getFilePath()), line: (name ?? node).getStartLineNumber() };
  }

  // The node an ast-grep match covers (same start and end offsets).
  nodeAt(path: string, start: number, end: number): Node | undefined {
    for (let node: Node | undefined = this.file(path).getDescendantAtPos(start); node !== undefined; node = node.getParent()) {
      if (node.getStart() === start && node.getEnd() === end) return node;
      if (node.getStart() < start) return undefined;
    }
    return undefined;
  }

  // The concrete expressions or declarations an expression may stand for. An unknown value comes back as itself.
  values(expression: Node, env: Env = NO_ENV, depth = 0): Node[] {
    if (depth > MAX_DEPTH) return [];
    const node = unwrap(expression);
    if (Node.isIdentifier(node)) {
      const definition = node.getDefinitionNodes()[0];
      return definition === undefined ? [node] : this.declarationValues(definition, env, depth + 1);
    }
    if (node.getKind() === SyntaxKind.ThisKeyword) return [thisOwner(node) ?? node];
    if (Node.isPropertyAccessExpression(node)) {
      const found = this.values(node.getExpression(), env, depth + 1).flatMap((value) => this.member(value, node.getName(), env, depth + 1));
      if (found.length > 0) return found;
      const definition = node.getNameNode().getDefinitionNodes()[0];
      return definition === undefined ? [node] : this.declarationValues(definition, env, depth + 1);
    }
    if (Node.isElementAccessExpression(node)) {
      const index = node.getArgumentExpression();
      const key = index === undefined ? undefined : this.string(index, env, depth + 1);
      if (key === undefined) return [node];
      return this.values(node.getExpression(), env, depth + 1).flatMap((value) => {
        if (!Node.isArrayLiteralExpression(value)) return this.member(value, key, env, depth + 1);
        const item = value.getElements()[Number(key)];
        return item === undefined ? [] : this.values(item, env, depth + 1);
      });
    }
    if (Node.isCallExpression(node)) {
      const functions = this.values(node.getExpression(), env, depth + 1).filter((value) => isFunctionLike(value) && inProject(value));
      if (functions.length === 0) return [node];
      return functions.flatMap((fn) => {
        const bound = this.bindParameters(fn, node.getArguments(), env);
        return returnsOf(fn).flatMap((result) => this.values(result, bound, depth + 1));
      });
    }
    if (Node.isConditionalExpression(node)) return [...this.values(node.getWhenTrue(), env, depth + 1), ...this.values(node.getWhenFalse(), env, depth + 1)];
    if (Node.isBinaryExpression(node) && ['??', '||'].includes(node.getOperatorToken().getText())) {
      return [...this.values(node.getLeft(), env, depth + 1), ...this.values(node.getRight(), env, depth + 1)];
    }
    return [node];
  }

  private declarationValues(declaration: Node, env: Env, depth: number): Node[] {
    const bound = env.get(keyOf(declaration));
    if (bound !== undefined) return bound === declaration ? [declaration] : this.values(bound, env, depth + 1);
    if (Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration) || Node.isPropertyDeclaration(declaration)) {
      const initializer = declaration.getInitializer();
      return initializer === undefined ? [declaration] : this.values(initializer, env, depth + 1);
    }
    if (Node.isParameterDeclaration(declaration)) return this.parameterValues(declaration, depth);
    if (Node.isBindingElement(declaration)) return this.destructuredValues(declaration, env, depth);
    if (Node.isExportAssignment(declaration)) return this.values(declaration.getExpression(), env, depth + 1);
    return [declaration];
  }

  // A parameter outside any binding takes the values of the arguments its callers pass (or its default).
  private parameterValues(parameter: ParameterDeclaration, depth: number): Node[] {
    const fn = parameter.getParent();
    if (!Node.isFunctionLikeDeclaration(fn)) return [parameter];
    const index = fn.getParameters().indexOf(parameter);
    const args = this.callSites(fn).map((call) => call.getArguments()[index] ?? parameter.getInitializer());
    const found = args.flatMap((arg) => (arg === undefined ? [] : this.values(arg, NO_ENV, depth + 1)));
    return found.length > 0 ? found : [parameter];
  }

  private destructuredValues(element: Node, env: Env, depth: number): Node[] {
    if (!Node.isBindingElement(element)) return [element];
    const pattern = element.getParentOrThrow();
    const holder = pattern.getParent();
    const initializer = Node.isVariableDeclaration(holder) ? holder.getInitializer() : undefined;
    if (initializer === undefined) return [element];
    const sources = this.values(initializer, env, depth + 1);
    if (Node.isObjectBindingPattern(pattern)) {
      const name = (element.getPropertyNameNode() ?? element.getNameNode()).getText();
      return sources.flatMap((source) => this.member(source, name, env, depth + 1));
    }
    const index = pattern.getElements().indexOf(element);
    return sources.flatMap((source) => {
      const item = Node.isArrayLiteralExpression(source) ? source.getElements()[index] : undefined;
      return item === undefined ? [] : this.values(item, env, depth + 1);
    });
  }

  private member(value: Node, name: string, env: Env, depth: number): Node[] {
    if (depth > MAX_DEPTH) return [];
    if (Node.isObjectLiteralExpression(value)) {
      const property = value.getProperty(name);
      if (Node.isPropertyAssignment(property)) return this.values(property.getInitializerOrThrow(), env, depth + 1);
      if (Node.isShorthandPropertyAssignment(property)) return this.values(property.getNameNode(), env, depth + 1);
      return Node.isMethodDeclaration(property) ? [property] : [];
    }
    if (Node.isNewExpression(value)) {
      return this.values(value.getExpression(), env, depth + 1).flatMap((cls) => (Node.isClassDeclaration(cls) ? this.classMember(cls, name, env, depth + 1) : []));
    }
    if (Node.isClassDeclaration(value)) return this.classMember(value, name, env, depth + 1);
    if (Node.isSourceFile(value)) return (value.getExportedDeclarations().get(name) ?? []).flatMap((declaration) => this.declarationValues(declaration, env, depth + 1));
    return [];
  }

  private classMember(cls: Node, name: string, env: Env, depth: number): Node[] {
    if (!Node.isClassDeclaration(cls) || depth > MAX_DEPTH) return [];
    const member = cls.getInstanceMember(name);
    if (Node.isMethodDeclaration(member)) return [member];
    if (Node.isParameterDeclaration(member)) return this.declarationValues(member, env, depth + 1);
    const initializer = Node.isPropertyDeclaration(member) ? member.getInitializer() : undefined;
    if (initializer !== undefined) return this.values(initializer, env, depth + 1);
    // Assigned in the class body instead: this.app = express()
    const assigned = cls
      .getDescendantsOfKind(SyntaxKind.BinaryExpression)
      .filter((binary) => binary.getOperatorToken().getKind() === SyntaxKind.EqualsToken && binary.getLeft().getText() === `this.${name}`)
      .flatMap((binary) => this.values(binary.getRight(), env, depth + 1));
    if (assigned.length > 0) return assigned;
    const base = cls.getBaseClass();
    return base === undefined ? [] : this.classMember(base, name, env, depth + 1);
  }

  // Calls of a function, method or constructor, across the repo. Files that mention its name are loaded first,
  // because references are only found in loaded files.
  callSites(fn: Node): (CallExpression | NewExpression)[] {
    const target = Node.isConstructorDeclaration(fn) ? fn.getParent() : holderOf(fn);
    if (!Node.isReferenceFindable(target) || !Node.hasName(target)) return [];
    const name = target.getName();
    const word = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
    for (const [path, text] of this.sources) if (!this.loaded.has(path) && word.test(text)) this.file(path);
    return target.findReferencesAsNodes().flatMap((reference) => {
      const parent = reference.getParent();
      const callee = Node.isPropertyAccessExpression(parent) && parent.getNameNode() === reference ? parent : reference;
      const call = callee.getParent();
      return (Node.isCallExpression(call) || Node.isNewExpression(call)) && call.getExpression() === callee ? [call] : [];
    });
  }

  // Binds a function's parameters to one call's arguments; a missing argument takes the default, or stays unknown.
  bindParameters(fn: Node, args: readonly Node[], env: Env): Env {
    const bound = new Map(env);
    if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
      fn.getParameters().forEach((parameter, i) => bound.set(keyOf(parameter), args[i] ?? parameter.getInitializer() ?? parameter));
    }
    return bound;
  }

  // One environment per iteration of the loops around a node (for...of, forEach, map, flatMap), [NO_ENV] when
  // there are none, undefined when a loop runs over something other than a literal array.
  loops(node: Node): Env[] | undefined {
    const loops: { iterable: Node; binding: Node | undefined }[] = [];
    let child = node;
    for (let current = node.getParent(); current !== undefined; child = current, current = current.getParent()) {
      if (Node.isForOfStatement(current) && current.getStatement() === child) {
        const list = current.getInitializer();
        const declaration = Node.isVariableDeclarationList(list) ? list.getDeclarations()[0] : undefined;
        loops.unshift({ iterable: current.getExpression(), binding: declaration?.getNameNode() });
      }
      const call = current.getParent();
      if ((Node.isArrowFunction(current) || Node.isFunctionExpression(current)) && Node.isCallExpression(call) && call.getArguments()[0] === current) {
        const callee = call.getExpression();
        if (Node.isPropertyAccessExpression(callee) && LOOP_METHODS.has(callee.getName())) {
          loops.unshift({ iterable: callee.getExpression(), binding: current.getParameters()[0]?.getNameNode() });
        }
      }
    }
    let envs: Env[] = [NO_ENV];
    for (const { iterable, binding } of loops) {
      const next: Env[] = [];
      for (const env of envs) {
        const elements = this.elements(iterable, env);
        if (elements === undefined) return undefined;
        for (const element of elements) next.push(binding === undefined ? env : this.bind(binding, element, env));
      }
      envs = next;
    }
    return envs;
  }

  private elements(iterable: Node, env: Env, depth = 0): Node[] | undefined {
    const arrays = this.values(iterable, env).filter((value) => Node.isArrayLiteralExpression(value));
    if (arrays.length === 0 || depth > MAX_DEPTH) return undefined;
    const found: Node[] = [];
    for (const array of arrays) {
      for (const element of array.getElements()) {
        if (Node.isOmittedExpression(element)) continue;
        if (!Node.isSpreadElement(element)) {
          found.push(element);
          continue;
        }
        const spread = this.elements(element.getExpression(), env, depth + 1);
        if (spread === undefined) return undefined;
        found.push(...spread);
      }
    }
    return found;
  }

  private bind(binding: Node, element: Node, env: Env): Env {
    const bound = new Map(env);
    if (Node.isIdentifier(binding)) bound.set(keyOf(binding.getParentOrThrow()), element);
    if (Node.isObjectBindingPattern(binding)) {
      for (const item of binding.getElements()) {
        const name = (item.getPropertyNameNode() ?? item.getNameNode()).getText();
        const value = this.values(element, env).flatMap((source) => {
          const property = Node.isObjectLiteralExpression(source) ? source.getProperty(name) : undefined;
          if (Node.isPropertyAssignment(property)) return [property.getInitializerOrThrow()];
          return Node.isShorthandPropertyAssignment(property) ? [property.getNameNode()] : [];
        })[0];
        if (value !== undefined) bound.set(keyOf(item), value);
      }
    }
    if (Node.isArrayBindingPattern(binding)) {
      binding.getElements().forEach((item, i) => {
        const value = this.values(element, env).flatMap((source) => (Node.isArrayLiteralExpression(source) ? source.getElements().slice(i, i + 1) : []))[0];
        if (Node.isBindingElement(item) && value !== undefined) bound.set(keyOf(item), value);
      });
    }
    return bound;
  }

  // The string an expression always has, or undefined when source doesn't fix it.
  string(expression: Node, env: Env = NO_ENV, depth = 0): string | undefined {
    const node = unwrap(expression);
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
    if (Node.isNumericLiteral(node)) return String(node.getLiteralValue());
    if (Node.isTemplateExpression(node)) {
      let text = node.getHead().getLiteralText();
      for (const span of node.getTemplateSpans()) {
        const part = this.string(span.getExpression(), env, depth + 1);
        if (part === undefined) return undefined;
        text += part + span.getLiteral().getLiteralText();
      }
      return text;
    }
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      const [left, right] = [this.string(node.getLeft(), env, depth + 1), this.string(node.getRight(), env, depth + 1)];
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (depth > MAX_DEPTH) return undefined;
    const candidates = this.values(node, env, depth + 1);
    if (candidates.length === 0 || candidates.some((candidate) => candidate === node || !Node.isExpression(candidate))) return undefined;
    const strings = new Set(candidates.map((candidate) => this.string(candidate, env, depth + 1)));
    return strings.size === 1 ? [...strings][0] : undefined;
  }

  number(expression: Node, env: Env = NO_ENV): number | undefined {
    const text = this.string(expression, env);
    return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
  }

  // The named project declaration behind an expression: for a call, its callee's (a middleware factory);
  // undefined for library code and anything unresolved.
  declaration(expression: Node, env: Env = NO_ENV): Node | undefined {
    const node = unwrap(expression);
    const target = Node.isCallExpression(node) ? node.getExpression() : node;
    const value = this.values(target, env).find(
      (candidate) => inProject(candidate) && !Node.isIdentifier(candidate) && !Node.isPropertyAccessExpression(candidate) && !Node.isParameterDeclaration(candidate),
    );
    return value === undefined ? undefined : holderOf(value);
  }
}
