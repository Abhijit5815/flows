import { readFileSync } from 'node:fs';
import { Node, SyntaxKind } from 'ts-morph';
import { z } from 'zod';
import { PatternRuleSchema } from '../../ingest/match.ts';
import { holderOf, importOf, inProject, isFunctionLike, keyOf, NO_ENV, qualifiedName, type Env } from '../../ingest/resolve.ts';
import type { Field } from '../../model/flow.ts';
import type { ExtractContext, FrameworkAdapter, Unrecognised } from '../adapter.ts';

// The rules are data (rules.json); this file follows what they match: routers, mounts, routes, handlers,
// guards, request schemas, responses and the Prisma models a handler touches.
const RULES = z
  .object({ patterns: z.array(PatternRuleSchema), suspects: z.array(PatternRuleSchema), guards: z.object({ name: z.string(), body: z.string() }) })
  .parse(JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8')));
const GUARD_NAME = new RegExp(RULES.guards.name, 'i');
const GUARD_BODY = new RegExp(RULES.guards.body);

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
// Response methods that finish a request, with the status they send when no .status(n) comes first.
const SENDS = new Map([['json', 200], ['send', 200], ['jsonp', 200], ['end', 200], ['render', 200], ['sendFile', 200], ['download', 200], ['sendStatus', 200], ['redirect', 302]]);
const PRISMA_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy']);

type Uses = { node: Node; env: Env };
type Registration = { routers: string[]; method: string; path: string; handlers: Node[]; env: Env; file: string; line: number; pos: number };
type Mount = { parent: string; prefix: string; children: string[]; middleware: Uses[]; file: string; pos: number };

// Express joins mount prefixes and route paths; "/" adds nothing and there is no trailing slash.
export function joinPath(...parts: string[]): string {
  const joined = `/${parts.join('/')}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

// express() makes an app and Router() / express.Router() a router; recognised by the import, not the name.
function routerKind(node: Node): 'app' | 'router' | undefined {
  if (!Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  if (Node.isIdentifier(callee)) {
    const from = importOf(callee);
    if (from?.module !== 'express') return undefined;
    return from.name === 'Router' ? 'router' : from.name === 'default' || from.name === '*' ? 'app' : undefined;
  }
  if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'Router') {
    const object = callee.getExpression();
    return Node.isIdentifier(object) && importOf(object)?.module === 'express' ? 'router' : undefined;
  }
  return undefined;
}

// A parameter whose value Flows can't follow (the app handed in through require()), named by its type annotation:
// app: express.Application is the app, route: Router a router.
function annotatedKind(node: Node): 'app' | 'router' | undefined {
  let type: string | undefined;
  if (Node.isParameterDeclaration(node)) type = node.getTypeNode()?.getText();
  if (Node.isBindingElement(node)) {
    const parameter = node.getFirstAncestor((ancestor) => Node.isParameterDeclaration(ancestor));
    const literal = Node.isParameterDeclaration(parameter) ? parameter.getTypeNode() : undefined;
    const name = node.getPropertyNameNode()?.getText() ?? node.getName();
    const member = Node.isTypeLiteral(literal) ? literal.getProperty(name) : undefined;
    type = Node.isPropertySignature(member) ? member.getTypeNode()?.getText() : undefined;
  }
  if (type === undefined) return undefined;
  return /^(express\.)?(Application|Express)$/.test(type) ? 'app' : /^(express\.)?Router$/.test(type) ? 'router' : undefined;
}

// A Zod schema (built from z, or derived from another schema) or a class-validator DTO.
function isSchema(declaration: Node, depth = 0): boolean {
  if (Node.isClassDeclaration(declaration)) return declaration.getProperties().some((property) => property.getDecorators().length > 0);
  if (!Node.isVariableDeclaration(declaration) || depth > 4) return false;
  let root = declaration.getInitializer();
  while (Node.isCallExpression(root) || Node.isPropertyAccessExpression(root)) root = root.getExpression();
  if (!Node.isIdentifier(root)) return false;
  if (importOf(root)?.module === 'zod') return true;
  const source = root.getDefinitionNodes()[0];
  return source !== undefined && isSchema(source, depth + 1);
}

// A field's Zod chain, z.string().email().min(8).optional(): the base type, then every other link as a rule.
function fieldOf(name: string, value: Node): Field {
  const chain: string[] = [];
  let base = value;
  while (Node.isCallExpression(base)) {
    const callee = base.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) break;
    const args = base.getArguments().map((arg) => arg.getText()).join(', ');
    chain.unshift(args === '' ? callee.getName() : args.length <= 60 ? `${callee.getName()}(${args})` : `${callee.getName()}(…)`);
    base = callee.getExpression();
  }
  // From z the first link is the type (string, enum([...])); otherwise the base is another schema, used as the type.
  const [type, ...rules] = Node.isIdentifier(base) && importOf(base)?.module === 'zod' && chain.length > 0 ? chain : [base.getText(), ...chain];
  const bare = type.replace(/\(.*$/s, '');
  return {
    name,
    type: bare,
    required: !rules.some((rule) => rule === 'optional' || rule === 'nullish' || rule.startsWith('default(')),
    rules: [...(bare === type ? [] : [type]), ...rules.filter((rule) => rule !== 'optional')],
  };
}

// The fields of a Zod object schema, followed through the schemas it is derived from (pick, omit, extend, partial).
// shortcut: class-validator DTOs and shapes built in code give no fields; read them when a team needs them.
function zodFields(expression: Node | undefined, depth = 0): Field[] | undefined {
  if (expression === undefined || depth > 4) return undefined; // depth: hops from one schema to another
  if (Node.isVariableDeclaration(expression)) return zodFields(expression.getInitializer(), depth);
  if (Node.isIdentifier(expression)) return zodFields(expression.getDefinitionNodes()[0], depth + 1);
  if (!Node.isCallExpression(expression)) return undefined;
  const callee = expression.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const [arg] = expression.getArguments();
  const literal = Node.isObjectLiteralExpression(arg) ? arg : undefined;
  const own = () => literal?.getProperties().flatMap((property) => (Node.isPropertyAssignment(property) ? [fieldOf(property.getName(), property.getInitializerOrThrow())] : [])) ?? [];
  const base = callee.getExpression();
  if (callee.getName() === 'object' && Node.isIdentifier(base) && importOf(base)?.module === 'zod') return literal === undefined ? undefined : own();
  const inner = zodFields(base, depth);
  if (inner === undefined) return undefined;
  const keys = literal?.getProperties().flatMap((property) => (Node.hasName(property) ? [property.getName()] : [])) ?? [];
  switch (callee.getName()) {
    case 'pick':
      return inner.filter((field) => keys.includes(field.name));
    case 'omit':
      return inner.filter((field) => !keys.includes(field.name));
    case 'extend':
      return [...inner.filter((field) => !keys.includes(field.name)), ...own()];
    case 'partial':
      return inner.map((field) => ({ ...field, required: false }));
    default:
      return inner; // strict, refine, transform, describe: the same fields
  }
}

// The identifier at the base of a call chain (res in res.status(201).json(...)) is one of the response parameters.
function isResponse(expression: Node, responses: ReadonlySet<string>): boolean {
  let base = expression;
  for (let callee = Node.isCallExpression(base) ? base.getExpression() : undefined; Node.isPropertyAccessExpression(callee); ) {
    base = callee.getExpression();
    callee = Node.isCallExpression(base) ? base.getExpression() : undefined;
  }
  if (!Node.isIdentifier(base)) return false;
  const declaration = base.getSymbol()?.getDeclarations()[0];
  return declaration !== undefined && responses.has(keyOf(declaration));
}

function extract({ facts, files, read, resolver, graph, guards }: ExtractContext): Unrecognised[] {
  const notes: Unrecognised[] = [];
  const kinds = new Map<string, 'app' | 'router'>();
  const registrations: Registration[] = [];
  const mounts: Mount[] = [];

  // use() and the route methods return the router itself, so Router().use(a).use(b) is the Router() at its start.
  const chained = (node: Node): Node | undefined => {
    const callee = Node.isCallExpression(node) ? node.getExpression() : undefined;
    return Node.isPropertyAccessExpression(callee) && (callee.getName() === 'use' || ROUTE_METHODS.has(callee.getName())) ? callee.getExpression() : undefined;
  };
  const routersOf = (expression: Node, env: Env, depth = 0): string[] => {
    const start = chained(expression);
    if (start !== undefined) return depth < 20 ? routersOf(start, env, depth + 1) : [];
    // Router() itself: resolving the call would look for what it returns, which is library code.
    const own = routerKind(expression);
    if (own !== undefined) {
      kinds.set(keyOf(expression), own);
      return [keyOf(expression)];
    }
    return resolver.values(expression, env).flatMap((value) => {
      const inner = value === expression ? undefined : chained(value);
      if (inner !== undefined) return depth < 20 ? routersOf(inner, env, depth + 1) : [];
      const kind = routerKind(value) ?? annotatedKind(value);
      if (kind === undefined) return [];
      kinds.set(keyOf(value), kind);
      return [keyOf(value)];
    });
  };

  // use(path?, ...middleware): the first argument is a path unless it is a function, a router or a call.
  const isPath = (arg: Node, env: Env): boolean => {
    if (resolver.string(arg, env) !== undefined) return true;
    if (Node.isCallExpression(arg) || isFunctionLike(arg)) return false;
    return !resolver.values(arg, env).some((value) => isFunctionLike(value) || Node.isCallExpression(value) || Node.isNewExpression(value) || Node.isClassDeclaration(value));
  };

  const register = (routers: string[], method: string, args: Node[], name: Node, env: Env): void => {
    const where = resolver.where(name);
    const path = resolver.string(args[0], env);
    if (path === undefined) {
      notes.push({ ...where, reason: `route path ${args[0].getText()} is not a fixed string` });
      return;
    }
    registrations.push({ routers, method: method === 'all' ? 'ALL' : method.toUpperCase(), path, handlers: args.slice(1), env, ...where, pos: name.getStart() });
  };

  for (const [file, { facts: list }] of facts) {
    for (const fact of list) {
      const call = resolver.nodeAt(file, fact.start, fact.end);
      if (!Node.isCallExpression(call)) continue;
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) && !Node.isElementAccessExpression(callee)) continue;
      // A loop over a list Flows can't read is evaluated once; whatever depends on it stays unknown and is reported.
      for (const env of resolver.loops(call) ?? [NO_ENV]) {
        const routers = routersOf(callee.getExpression(), env);
        if (routers.length === 0) continue; // not a router: axios.get, io.use, a supertest agent
        if (fact.rule === 'route') {
          // router.get(...), or router[method](...) (a learned rule) with the method read from source
          const name = Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee.getArgumentExpressionOrThrow();
          const method = Node.isPropertyAccessExpression(callee) ? callee.getName() : resolver.string(name, env);
          if (method !== undefined && ROUTE_METHODS.has(method)) register(routers, method, call.getArguments(), name, env);
        }
        if (fact.rule === 'route-chain' && Node.isPropertyAccessExpression(callee)) {
          // router.route(path).get(...).post(...): one route per method in the chain
          const [path] = call.getArguments();
          for (let link: Node = call; ; ) {
            const access = link.getParent();
            const next = access?.getParent();
            if (!Node.isPropertyAccessExpression(access) || !Node.isCallExpression(next) || next.getExpression() !== access) break;
            if (ROUTE_METHODS.has(access.getName()) && path !== undefined) register(routers, access.getName(), [path, ...next.getArguments()], access.getNameNode(), env);
            link = next;
          }
        }
        if (fact.rule === 'mount') {
          let args = call.getArguments();
          let prefix = '';
          if (args.length > 1 && isPath(args[0], env)) {
            const value = resolver.string(args[0], env);
            if (value === undefined) {
              notes.push({ ...resolver.where(call), reason: `mount path ${args[0].getText()} is not a fixed string` });
              continue;
            }
            prefix = value;
            args = args.slice(1);
          }
          const children: string[] = [];
          const middleware: Uses[] = [];
          for (const arg of args) {
            const found = routersOf(arg, env);
            if (found.length > 0) children.push(...found);
            else middleware.push({ node: arg, env });
          }
          for (const parent of routers) mounts.push({ parent, prefix, children, middleware, file, pos: call.getStart() });
        }
      }
    }
  }

  // Middleware registered on a router without a path runs for everything registered after it (same file, in order).
  const usedBefore = (router: string, file: string, pos: number): Uses[] =>
    mounts.filter((m) => m.parent === router && joinPath(m.prefix) === '/' && m.file === file && m.pos < pos).flatMap((m) => m.middleware);

  // Every way a router is reachable from an app: the joined prefix and the middleware picked up on the way.
  const variants = (router: string, seen: ReadonlySet<string>): { prefix: string; middleware: Uses[] }[] => {
    if (kinds.get(router) === 'app') return [{ prefix: '', middleware: [] }];
    if (seen.has(router)) return [];
    return mounts
      .filter((m) => m.children.includes(router))
      .flatMap((m) =>
        variants(m.parent, new Set([...seen, router])).map((v) => ({
          prefix: joinPath(v.prefix, m.prefix),
          middleware: [...v.middleware, ...usedBefore(m.parent, m.file, m.pos), ...m.middleware],
        })),
      );
  };

  // Prisma models, by the name the client uses for them (OrderItem -> prisma.orderItem).
  const models = new Map<string, string>();
  for (const path of files.filter((file) => file.endsWith('.prisma'))) {
    read(path).split('\n').forEach((text, i) => {
      const name = /^\s*model\s+(\w+)\s*\{/.exec(text)?.[1];
      if (name === undefined) return;
      models.set(name[0].toLowerCase() + name.slice(1), graph.add(`model:${name}`, { kind: 'model', name, file: path, line: i + 1, attrs: { name } }));
    });
  }

  const addSchema = (route: string, expression: Node, env: Env): void => {
    const declaration = resolver.declaration(expression, env);
    if (declaration === undefined || !isSchema(declaration)) return;
    const name = qualifiedName(declaration) ?? declaration.getText();
    const fields = zodFields(declaration);
    graph.edge(route, graph.add(keyOf(declaration), { kind: 'request-schema', name, ...resolver.where(declaration), attrs: { name, ...(fields === undefined || fields.length === 0 ? {} : { fields }) } }), 'validated-by');
  };

  const addMiddleware = (route: string, { node, env }: Uses): void => {
    const values = resolver.values(node, env);
    if (values.length === 1 && Node.isArrayLiteralExpression(values[0])) {
      for (const element of values[0].getElements()) addMiddleware(route, { node: element, env });
      return;
    }
    const declaration = resolver.declaration(node, env);
    if (declaration === undefined) return; // library middleware: express.json(), cors(), helmet()
    const where = resolver.where(declaration);
    const base = qualifiedName(declaration) ?? `inline ${where.file}:${where.line}`;
    const guard = guards.includes(base) || GUARD_NAME.test(base) || GUARD_BODY.test(declaration.getText());
    // A guard made by a call is one guard per argument, requireRole('admin'): the role is what a test needs.
    const args = guard && Node.isCallExpression(node) ? node.getArguments().map((arg) => resolver.string(arg, env)) : [];
    const fixed = args.length > 0 && args.every((arg) => arg !== undefined) ? (args as string[]) : [];
    const name = fixed.length === 0 ? base : `${base}(${fixed.map((arg) => `'${arg}'`).join(', ')})`;
    const owner = graph.add(fixed.length === 0 ? keyOf(declaration) : `${keyOf(declaration)}(${fixed.join(',')})`, { kind: guard ? 'guard' : 'middleware', name, ...where, attrs: { name } });
    graph.edge(route, owner, guard ? 'guarded-by' : 'uses');
    if (!responded.has(owner)) {
      responded.add(owner);
      // What it answers when it stops the request (401, 403, 400): the middleware itself, or the one a factory returns.
      const fn = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : declaration;
      for (const inner of fn === undefined ? [] : [fn, ...fn.getDescendants()].filter((each) => isFunctionLike(each))) addResponses(owner, name, inner);
    }
    if (Node.isCallExpression(node)) for (const arg of node.getArguments()) addSchema(route, arg, env); // validate(schema)
  };

  // Responses a function sends: res.<send>(...) on a response parameter, or through a helper it hands res to.
  // messages: the string literals at the site (fail(res, 404, 'order not found')) or in the body sent.
  type Sent = Map<number | undefined, { fields: string[]; messages: string[]; site: Node }>;
  const literals = (nodes: readonly Node[]): string[] => nodes.flatMap((node) => (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? [node.getLiteralValue()] : []));
  const collectResponses = (fn: Node, responses: ReadonlySet<string>, env: Env, depth: number, site: Node | undefined, sent: Sent): void => {
    for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const here = site ?? call;
      if (Node.isPropertyAccessExpression(callee) && SENDS.has(callee.getName()) && isResponse(callee.getExpression(), responses)) {
        const method = callee.getName();
        let status = method === 'sendStatus' ? resolver.number(call.getArguments()[0], env) : SENDS.get(method);
        for (let link = callee.getExpression(); Node.isCallExpression(link); ) {
          const inner = link.getExpression();
          if (!Node.isPropertyAccessExpression(inner)) break;
          if (inner.getName() === 'status') {
            status = resolver.number(link.getArguments()[0], env);
            break;
          }
          link = inner.getExpression();
        }
        const body = ['json', 'send', 'jsonp'].includes(method) ? call.getArguments()[0] : undefined;
        const object = body === undefined ? undefined : resolver.values(body, env).find((value) => Node.isObjectLiteralExpression(value));
        const properties = Node.isObjectLiteralExpression(object) ? object.getProperties() : [];
        const fields = properties.flatMap((property) => (Node.hasName(property) ? [property.getName()] : []));
        const messages = literals([...(Node.isCallExpression(here) && here !== call ? here.getArguments() : []), ...properties.flatMap((property) => (Node.isPropertyAssignment(property) ? [property.getInitializerOrThrow()] : []))]);
        const seen = sent.get(status);
        if (seen === undefined) sent.set(status, { fields, messages, site: here });
        else {
          seen.fields.push(...fields.filter((field) => !seen.fields.includes(field)));
          seen.messages.push(...messages.filter((message) => !seen.messages.includes(message)));
        }
        continue;
      }
      if (depth >= 2) continue;
      const passed = call.getArguments().flatMap((arg, i) => (isResponse(arg, responses) ? [i] : []));
      if (passed.length === 0) continue;
      for (const helper of resolver.values(callee, env)) {
        if (!(Node.isArrowFunction(helper) || Node.isFunctionExpression(helper) || Node.isFunctionDeclaration(helper) || Node.isMethodDeclaration(helper)) || !inProject(helper) || helper === fn) continue;
        const parameters = helper.getParameters();
        const own = new Set(passed.flatMap((i) => (parameters[i] === undefined ? [] : [keyOf(parameters[i])])));
        collectResponses(helper, own, resolver.bindParameters(helper, call.getArguments(), env), depth + 1, here, sent);
      }
    }
  };

  // Models a function touches through the Prisma client, in its own body or one call away (a service).
  const modelsIn = (fn: Node, depth: number): string[] =>
    fn.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((call) => {
      const operation = call.getExpression();
      if (Node.isPropertyAccessExpression(operation) && PRISMA_OPERATIONS.has(operation.getName())) {
        const delegate = operation.getExpression();
        const model = Node.isPropertyAccessExpression(delegate) ? models.get(delegate.getName()) : undefined;
        if (model !== undefined) return [model];
      }
      if (depth > 0) return [];
      // One call away: the called function's own declaration, found without evaluating the call's arguments.
      const name = Node.isPropertyAccessExpression(operation) ? operation.getNameNode() : operation;
      const declaration = Node.isIdentifier(name) ? name.getDefinitionNodes()[0] : undefined;
      const callee = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : declaration;
      return callee !== undefined && isFunctionLike(callee) && inProject(callee) && callee !== fn ? modelsIn(callee, depth + 1) : [];
    });

  // Zod schemas a handler parses itself: schema.parse(req.body), safeParse, parseAsync.
  const parsedSchemas = (fn: Node): Node[] =>
    fn.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((call) => {
      const callee = call.getExpression();
      return Node.isPropertyAccessExpression(callee) && /^(safe)?[pP]arse(Async)?$/.test(callee.getName()) ? [callee.getExpression()] : [];
    });

  // A response node per status a function sends, linked from the handler, guard or middleware it belongs to.
  const responded = new Set<string>();
  const addResponses = (owner: string, name: string, fn: Node): void => {
    const sent: Sent = new Map();
    const response = Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) ? fn.getParameters()[1] : undefined;
    if (response !== undefined) collectResponses(fn, new Set([keyOf(response)]), NO_ENV, 0, undefined, sent);
    for (const [status, { fields, messages, site }] of sent) {
      const node = graph.add(`${owner}#${status}`, { kind: 'response', name: `${name}#${status ?? 'unknown'}`, ...resolver.where(site), attrs: { status, fields, ...(messages.length > 0 ? { messages } : {}) } });
      graph.edge(owner, node, 'responds-with');
    }
  };

  const handled = new Map<string, Node[]>();
  const addHandler = (route: string, expression: Node, env: Env, inline: string): void => {
    const fn = resolver.values(expression, env).find((value) => isFunctionLike(value) && inProject(value));
    if (fn === undefined) {
      notes.push({ ...resolver.where(expression), reason: `handler ${expression.getText()} could not be resolved` });
      return;
    }
    const holder = holderOf(fn);
    const name = qualifiedName(holder) ?? inline;
    const handler = graph.add(keyOf(holder), { kind: 'handler', name, ...resolver.where(holder), attrs: { name } });
    graph.edge(route, handler, 'handled-by');
    if (!handled.has(handler)) {
      addResponses(handler, name, fn);
      for (const model of new Set(modelsIn(fn, 0))) graph.edge(handler, model, 'touches');
      handled.set(handler, parsedSchemas(fn));
    }
    for (const schema of handled.get(handler) ?? []) addSchema(route, schema, NO_ENV);
  };

  for (const registration of registrations) {
    for (const router of registration.routers) {
      const found = variants(router, new Set());
      if (found.length === 0) notes.push({ file: registration.file, line: registration.line, reason: 'on a router that is not mounted on the app in a way Flows follows' });
      for (const { prefix, middleware } of found) {
        const path = joinPath(prefix, registration.path);
        const name = `${registration.method} ${path}`;
        const route = graph.add(`route:${name}`, { kind: 'route', name, file: registration.file, line: registration.line, attrs: { method: registration.method, path } });
        const local = registration.handlers.slice(0, -1).map((node) => ({ node, env: registration.env }));
        for (const uses of [...middleware, ...usedBefore(router, registration.file, registration.pos), ...local]) addMiddleware(route, uses);
        const handler = registration.handlers.at(-1);
        if (handler !== undefined) addHandler(route, handler, registration.env, name);
      }
    }
  }
  return notes;
}

export const expressAdapter: FrameworkAdapter = {
  id: 'express',
  role: 'api',
  detection: { dependency: 'express', testedMajor: 4 },
  rules: RULES.patterns,
  suspects: RULES.suspects,
  extract,
};
