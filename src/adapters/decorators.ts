import { STATUS_CODES } from 'node:http';
import { Node, SyntaxKind, type ClassDeclaration, type Decorator, type MethodDeclaration } from 'ts-morph';
import { importOf, keyOf, qualifiedName } from '../ingest/resolve.ts';
import type { ExtractContext, Unrecognised } from './adapter.ts';
import { joinPath } from './paths.ts';
import { carriesOf, conditionOf, tokenIn } from './hints.ts';
import { schemaNode } from './schemas.ts';

// Decorator controllers, as routing-controllers and NestJS write them: a class names its route prefix, each method
// its verb and path, a parameter its body (a class-validator DTO), and errors are classes the framework turns into
// statuses. One reader for both, used by the Express adapter (routing-controllers) and the NestJS adapter.

const FRAMEWORKS = new Set(['routing-controllers', '@nestjs/common']);
const VERBS = new Map([['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'], ['Patch', 'PATCH'], ['Delete', 'DELETE'], ['Head', 'HEAD'], ['Options', 'OPTIONS'], ['All', 'ALL']] as const);
// The error classes the two frameworks ship, by the status each sends.
const ERROR_STATUS = new Map([
  ['BadRequestError', 400], ['UnauthorizedError', 401], ['ForbiddenError', 403], ['NotFoundError', 404], ['MethodNotAllowedError', 405], ['NotAcceptableError', 406], ['InternalServerError', 500],
  ['BadRequestException', 400], ['UnauthorizedException', 401], ['ForbiddenException', 403], ['NotFoundException', 404], ['ConflictException', 409], ['GoneException', 410],
  ['PayloadTooLargeException', 413], ['UnprocessableEntityException', 422], ['InternalServerErrorException', 500], ['NotImplementedException', 501], ['ServiceUnavailableException', 503],
]);
const STATUS_BY_NAME = new Map(Object.entries(STATUS_CODES).map(([code, text]) => [String(text).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''), Number(code)]));

type Sent = Map<number, { messages: string[]; site: Node; when: Record<string, string> }>;

export function decoratorControllers({ files, read, resolver, graph }: Pick<ExtractContext, 'files' | 'read' | 'resolver' | 'graph'>): Unrecognised[] {
  const notes: Unrecognised[] = [];
  const sources = files.filter((file) => /\.[cm]?tsx?$/.test(file) && !file.endsWith('.d.ts'));
  const nameOf = (decorator: Decorator): string | undefined => {
    const call = decorator.getCallExpression();
    const id = call === undefined ? decorator.getExpression() : call.getExpression();
    const imported = Node.isIdentifier(id) ? importOf(id) : undefined;
    return imported !== undefined && FRAMEWORKS.has(imported.module) ? imported.name : undefined;
  };
  const find = (node: ClassDeclaration | MethodDeclaration, ...names: string[]) => node.getDecorators().find((decorator) => names.includes(nameOf(decorator) ?? ''));
  const args = (decorator: Decorator | undefined) => decorator?.getCallExpression()?.getArguments() ?? [];
  // @Get('/:id'), @Controller('users'), @Controller({ path: 'users' }): the path, or '' when it names none.
  const pathOf = (decorator: Decorator): string => {
    const [first] = args(decorator);
    if (first === undefined) return '';
    if (Node.isObjectLiteralExpression(first)) {
      const path = first.getProperty('path');
      return Node.isPropertyAssignment(path) ? (resolver.string(path.getInitializerOrThrow()) ?? '') : '';
    }
    return resolver.string(first) ?? '';
  };
  const statusOf = (arg: Node | undefined) => (arg === undefined ? undefined : (resolver.number(arg) ?? (Node.isPropertyAccessExpression(arg) ? STATUS_BY_NAME.get(arg.getName()) : undefined)));
  const literals = (nodes: readonly Node[]) => nodes.flatMap((node) => (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? [node.getLiteralValue()] : []));

  // The status an error class sends: one the framework ships, HttpException(body, status) / HttpError(status, ...), or
  // the app's own class that extends one (class UserNotFoundError extends HttpError { super(404, '...') }).
  const errorStatus = (name: Node, made?: Node, depth = 0): { status: number; messages: string[] } | undefined => {
    const own = ERROR_STATUS.get(name.getText());
    const given = made !== undefined && (Node.isNewExpression(made) || Node.isCallExpression(made)) ? made.getArguments() : [];
    if (own !== undefined) return { status: own, messages: literals(given) };
    if (name.getText() === 'HttpException') return statusOf(given[1]) === undefined ? undefined : { status: statusOf(given[1]) as number, messages: literals(given) };
    if (name.getText() === 'HttpError') return statusOf(given[0]) === undefined ? undefined : { status: statusOf(given[0]) as number, messages: literals(given) };
    const cls = Node.isIdentifier(name) ? name.getDefinitionNodes()[0] : undefined;
    if (!Node.isClassDeclaration(cls) || depth > 3) return undefined;
    const base = cls.getExtends()?.getExpression();
    const superCall = cls.getConstructors()[0]?.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => call.getExpression().getKind() === SyntaxKind.SuperKeyword);
    return base === undefined ? undefined : errorStatus(base, superCall, depth + 1);
  };
  // Errors a method throws, in its body and one call away (the service it calls).
  const collectErrors = (fn: Node, depth: number, sent: Sent): void => {
    for (const made of fn.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const found = errorStatus(made.getExpression(), made);
      if (found === undefined || found.status < 400) continue;
      let entry = sent.get(found.status);
      if (entry === undefined) sent.set(found.status, (entry = { messages: found.messages, site: made, when: {} }));
      else {
        const seen = entry;
        seen.messages.push(...found.messages.filter((message) => !seen.messages.includes(message)));
      }
      const condition = conditionOf(made);
      if (condition !== undefined) for (const message of found.messages.length > 0 ? found.messages : ['']) entry.when[message] ??= condition;
    }
    if (depth > 0) return;
    for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const name = Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee;
      const target = Node.isIdentifier(name) ? name.getDefinitionNodes()[0] : undefined;
      if (Node.isMethodDeclaration(target) || Node.isFunctionDeclaration(target)) collectErrors(target, depth + 1, sent);
    }
  };
  const respond = (owner: string, name: string, status: number, site: Node, messages: string[] = [], extra: { when?: Record<string, string>; token?: string } = {}) =>
    graph.edge(owner, graph.add(`${owner}#${status}`, { kind: 'response', name: `${name}#${status}`, ...resolver.where(site), attrs: { status, fields: [], ...(messages.length > 0 ? { messages } : {}), ...(extra.when !== undefined && Object.keys(extra.when).length > 0 ? { when: extra.when } : {}), ...(extra.token === undefined ? {} : { token: extra.token }) } }), 'responds-with');
  // How the app's auth guards read the session: its passport strategy (ExtractJwt.fromAuthHeaderAsBearerToken()), found
  // anywhere in its code; a guard that says nothing reads the Authorization header's Bearer token.
  const strategy = sources.map((file) => read(file)).find((text) => /ExtractJwt|fromAuthHeader/.test(text));
  const carries = (strategy === undefined ? undefined : carriesOf(strategy)) ?? { header: 'Authorization', scheme: 'Bearer' };
  // @Authorized('admin') (401 without a user), @UseGuards(AuthGuard('jwt')) (401) or @UseGuards(RolesGuard) (403).
  const guardsOf = (node: ClassDeclaration | MethodDeclaration): string[] =>
    node.getDecorators().flatMap((decorator) => {
      const kind = nameOf(decorator);
      if (kind === 'Authorized') {
        const roles = literals(args(decorator));
        const name = roles.length === 0 ? 'Authorized' : `Authorized(${roles.map((role) => `'${role}'`).join(', ')})`;
        const guard = graph.add(`decorator-guard:${name}`, { kind: 'guard', name, ...resolver.where(decorator), attrs: { name, carries } });
        respond(guard, name, 401, decorator);
        return [guard];
      }
      if (kind !== 'UseGuards') return [];
      return args(decorator).map((arg) => {
        const name = arg.getText().replace(/\s+/g, ' ');
        const auth = /AuthGuard|Jwt|Auth\b/i.test(name);
        const guard = graph.add(`decorator-guard:${name}`, { kind: 'guard', name, ...resolver.where(decorator), attrs: { name, ...(auth ? { carries } : {}) } });
        respond(guard, name, auth ? 401 : 403, decorator);
        return guard;
      });
    });

  // The prefix every route sits under: NestJS's app.setGlobalPrefix('api'), routing-controllers' routePrefix option.
  let prefix = '';
  for (const file of sources.filter((path) => /setGlobalPrefix|routePrefix/.test(read(path)))) {
    for (const call of resolver.file(file).getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
      const option = call.getArguments().find((arg) => Node.isObjectLiteralExpression(arg));
      const route = Node.isObjectLiteralExpression(option) ? option.getProperty('routePrefix') : undefined;
      const value = name === 'setGlobalPrefix' ? call.getArguments()[0] : Node.isPropertyAssignment(route) && /^(createExpressServer|useExpressServer)$/.test(name) ? route.getInitializerOrThrow() : undefined;
      if (value === undefined) continue;
      const text = resolver.string(value);
      if (text !== undefined) prefix = text;
      else notes.push({ ...resolver.where(call), reason: `the route prefix ${value.getText()} comes from configuration, so the paths below are shown without it` });
    }
  }

  for (const file of sources.filter((path) => /from ['"](routing-controllers|@nestjs\/common)['"]/.test(read(path)))) {
    const nest = /from ['"]@nestjs\/common['"]/.test(read(file));
    for (const cls of resolver.file(file).getClasses()) {
      const controller = find(cls, 'Controller', 'JsonController');
      if (controller === undefined) continue;
      const classGuards = guardsOf(cls);
      for (const method of cls.getMethods()) {
        const verbDecorator = method.getDecorators().find((decorator) => VERBS.has(nameOf(decorator) as never));
        const verb = verbDecorator === undefined ? undefined : VERBS.get(nameOf(verbDecorator) as never);
        if (verbDecorator === undefined || verb === undefined) continue;
        const path = joinPath(prefix, pathOf(controller), pathOf(verbDecorator));
        const name = `${verb} ${path}`;
        const route = graph.add(`route:${name}`, { kind: 'route', name, ...resolver.where(verbDecorator), attrs: { method: verb, path } });
        const handlerName = qualifiedName(method) ?? `${cls.getName() ?? 'Controller'}.${method.getName()}`;
        // Path parameters it reads as numbers: @Param('id', ParseIntPipe), or @Param('id') id: number.
        const numeric = method.getParameters().flatMap((parameter) => {
          const param = parameter.getDecorators().find((decorator) => nameOf(decorator) === 'Param');
          const key = param === undefined ? undefined : literals(args(param))[0];
          return key !== undefined && (/ParseIntPipe|ParseFloatPipe/.test(param?.getText() ?? '') || parameter.getTypeNode()?.getText() === 'number') ? [key] : [];
        });
        const handler = graph.add(keyOf(method), { kind: 'handler', name: handlerName, ...resolver.where(method), attrs: { name: handlerName, ...(numeric.length > 0 ? { numeric } : {}) } });
        graph.edge(route, handler, 'handled-by');
        for (const guard of [...classGuards, ...guardsOf(method)]) graph.edge(route, guard, 'guarded-by');
        // Success: @HttpCode(n), else 201 for a NestJS POST and 200 otherwise.
        // A login's token: in what the method returns ({ user: { token } } is "user.token").
        const returned = method.getDescendantsOfKind(SyntaxKind.ReturnStatement).map((statement) => statement.getExpression()).find((value) => value !== undefined && tokenIn(value, resolver) !== undefined);
        const token = returned === undefined ? undefined : tokenIn(returned, resolver);
        respond(handler, handlerName, statusOf(args(find(method, 'HttpCode'))[0]) ?? (nest && verb === 'POST' ? 201 : 200), method, [], token === undefined ? {} : { token });
        const sent: Sent = new Map();
        collectErrors(method, 0, sent);
        // @OnUndefined(UserNotFoundError) / @OnNull(404): what it answers when the method returns nothing.
        for (const decorator of [find(method, 'OnUndefined'), find(method, 'OnNull')]) {
          const [arg] = args(decorator);
          const found = arg === undefined ? undefined : statusOf(arg) !== undefined ? { status: statusOf(arg) as number, messages: [] } : errorStatus(arg);
          if (found !== undefined && found.status >= 400 && decorator !== undefined) sent.set(found.status, { messages: found.messages, site: decorator, when: Object.fromEntries((found.messages.length > 0 ? found.messages : ['']).map((message) => [message, 'it returns nothing'])) });
        }
        for (const [status, { messages, site, when }] of sent) respond(handler, handlerName, status, site, messages, { when });
        // The body: the class of the parameter marked @Body().
        for (const parameter of method.getParameters()) {
          if (!parameter.getDecorators().some((decorator) => nameOf(decorator) === 'Body')) continue;
          const type = parameter.getTypeNode();
          const ref = Node.isTypeReference(type) ? type.getTypeName() : undefined;
          const schema = ref === undefined ? undefined : schemaNode(resolver, graph, ref);
          if (schema !== undefined) graph.edge(route, schema, 'validated-by');
        }
      }
    }
  }
  return notes;
}
