import { Node, SyntaxKind } from 'ts-morph';
import { isSource } from '../../ingest/match.ts';
import { holderOf, inProject, isFunctionLike, keyOf } from '../../ingest/resolve.ts';
import { HTTP_METHODS } from '../../model/flow.ts';
import type { ExtractContext, FrameworkAdapter, Unrecognised } from '../adapter.ts';
import { middlewareGuard, routePath } from '../nextjs-app/nextjs.ts';
import { conditionOf, tokenIn } from '../hints.ts';
import { parsedSchemas, schemaNode } from '../schemas.ts';

// Next.js App Router route handlers (app/**/route.ts) are an API: each exported GET, POST, ... is a route, read for
// the API role, so a Next.js app registered under both roles has UI flows and the API flows its pages call.

// "/api/products/[id]" -> "/api/products/:id", "/api/auth/[...nextauth]" -> "/api/auth/*": the API graph's path syntax.
const apiPath = (path: string) => path.replace(/\[\[?\.\.\.\w+\]\]?/g, '*').replace(/\[(\w+)\]/g, ':$1');
const RESPONSE = /^(NextResponse|Response)$/;

function extract({ files, resolver, graph }: ExtractContext): Unrecognised[] {
  const notes: Unrecognised[] = [];
  const appDir = files.some((file) => file.startsWith('app/')) ? 'app' : 'src/app';

  // What a handler answers: NextResponse.json(body, { status }), Response.json(...), new Response(body, { status }), in
  // its own body and in the app's functions it calls (return unauthorized(), error.toResponse()), one call deep.
  // A status computed at run time (from a lookup table) is not known, so that response is left out.
  const addResponses = (handler: string, name: string, fn: Node): void => {
    const sent = new Map<number, { fields: string[]; messages: string[]; site: Node; when: Record<string, string>; token?: string }>();
    const helpers = fn.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((call) => {
      const callee = call.getExpression();
      const id = Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee;
      const definition = Node.isIdentifier(id) ? id.getDefinitionNodes()[0] : undefined;
      const target = Node.isVariableDeclaration(definition) ? definition.getInitializer() : definition;
      return target !== undefined && target !== fn && (isFunctionLike(target) || Node.isMethodDeclaration(target)) && inProject(target) ? [target] : [];
    });
    for (const node of [fn, ...new Set(helpers)].flatMap((each) => each.getDescendants())) {
      const callee = Node.isCallExpression(node) ? node.getExpression() : undefined;
      const json = Node.isPropertyAccessExpression(callee) && callee.getName() === 'json' && RESPONSE.test(callee.getExpression().getText());
      const made = Node.isNewExpression(node) && RESPONSE.test(node.getExpression().getText());
      if (!json && !made) continue;
      const [body, init] = Node.isCallExpression(node) || Node.isNewExpression(node) ? node.getArguments() : [];
      const option = Node.isObjectLiteralExpression(init) ? init.getProperty('status') : undefined;
      const status = Node.isPropertyAssignment(option) ? resolver.number(option.getInitializerOrThrow()) : init === undefined ? 200 : undefined;
      if (status === undefined) continue;
      const object = body === undefined ? undefined : resolver.values(body).find((value) => Node.isObjectLiteralExpression(value));
      const properties = Node.isObjectLiteralExpression(object) ? object.getProperties() : [];
      const texts = [body, ...properties.map((property) => (Node.isPropertyAssignment(property) ? property.getInitializerOrThrow() : undefined))];
      const messages = texts.flatMap((text) => (Node.isStringLiteral(text) || Node.isNoSubstitutionTemplateLiteral(text) ? [text.getLiteralValue()] : []));
      const fields = properties.flatMap((property) => (Node.hasName(property) ? [property.getName()] : []));
      let entry = sent.get(status);
      if (entry === undefined) sent.set(status, (entry = { fields, messages, site: node, when: {} }));
      else {
        const seen = entry;
        seen.fields.push(...fields.filter((field) => !seen.fields.includes(field)));
        seen.messages.push(...messages.filter((message) => !seen.messages.includes(message)));
      }
      entry.token ??= status < 300 ? tokenIn(object, resolver) : undefined;
      const condition = conditionOf(node);
      if (condition !== undefined) for (const message of messages.length > 0 ? messages : ['']) entry.when[message] ??= condition;
    }
    for (const [status, { fields, messages, site, when, token }] of sent) {
      const extra = { ...(messages.length > 0 ? { messages } : {}), ...(Object.keys(when).length > 0 ? { when } : {}), ...(token === undefined ? {} : { token }) };
      const response = graph.add(`${handler}#${status}`, { kind: 'response', name: `${name}#${status}`, ...resolver.where(site), attrs: { status, fields, ...extra } });
      graph.edge(handler, response, 'responds-with');
    }
  };

  // Middleware (proxy.ts in Next.js 16) guards the API routes its matcher selects, with what it answers (a 401).
  const middleware = middlewareGuard({ files, resolver, graph });
  const body = middleware?.declaration === undefined ? undefined : Node.isVariableDeclaration(middleware.declaration) ? middleware.declaration.getInitializer() : middleware.declaration;
  if (middleware !== undefined && body !== undefined && isFunctionLike(body)) addResponses(middleware.guard, 'middleware', body);

  for (const file of files) {
    if (!file.startsWith(`${appDir}/`) || !isSource(file)) continue;
    const segments = file.slice(appDir.length + 1).split('/');
    const folder = segments.slice(0, -1);
    if (!/^route\.[cm]?[jt]sx?$/.test(segments.at(-1) ?? '') || folder.some((segment) => segment.startsWith('_'))) continue; // _private folders are not routes
    const path = apiPath(routePath(folder));
    for (const [method, declarations] of resolver.file(file).getExportedDeclarations()) {
      if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
      const declaration = declarations[0];
      const name = `${method} ${path}`;
      const route = graph.add(`route:${name}`, { kind: 'route', name, ...resolver.where(declaration), attrs: { method: method as (typeof HTTP_METHODS)[number], path } });
      if (middleware?.covers(routePath(folder))) graph.edge(route, middleware.guard, 'guarded-by');
      const value = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : declaration;
      const fn = value !== undefined && isFunctionLike(value) && inProject(value) ? value : resolver.values(value ?? declaration).find((each) => isFunctionLike(each) && inProject(each));
      if (fn === undefined) {
        notes.push({ ...resolver.where(declaration), reason: `${name}: its handler is library code (${(value ?? declaration).getText().slice(0, 40)}), so its responses are not known` });
        continue;
      }
      // Named after its route, like an inline Express handler: "Call GET /api/x", errors "from the handler".
      const handler = graph.add(keyOf(holderOf(fn)), { kind: 'handler', name, ...resolver.where(holderOf(fn)), attrs: { name } });
      graph.edge(route, handler, 'handled-by');
      addResponses(handler, name, fn);
      for (const parsed of parsedSchemas(fn)) {
        const schema = schemaNode(resolver, graph, parsed);
        if (schema !== undefined) graph.edge(route, schema, 'validated-by');
      }
    }
  }
  return notes;
}

export const nextApiAdapter: FrameworkAdapter = {
  id: 'nextjs-api',
  role: 'api',
  detection: { dependency: 'next', testedMajors: [14, 15, 16], needsOneOf: ['app', 'src/app'] },
  rules: [],
  suspects: [],
  extract,
};
