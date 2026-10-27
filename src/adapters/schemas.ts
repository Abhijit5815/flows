import { Node, SyntaxKind } from 'ts-morph';
import type { GraphBuilder } from '../graph/builder.ts';
import { importOf, keyOf, qualifiedName, type Env, type Resolver } from '../ingest/resolve.ts';
import type { Field } from '../model/flow.ts';

// Request body schemas, shared by the API adapters: whether a declaration is one, and the fields of a Zod object.

// A Zod schema (built from z, or derived from another schema) or a class-validator DTO.
export function isSchema(declaration: Node, depth = 0): boolean {
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
    const args = base.getArguments().map((arg) => arg.getText().replace(/\s+/g, ' ')).join(', ');
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
export function zodFields(expression: Node | undefined, depth = 0): Field[] | undefined {
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

// Zod schemas a handler parses the request body with: schema.parse(req.body), safeParse(await request.json()), a
// variable holding either. A schema for the route's params or query (routeContextSchema.parse(context)) is not a body.
const BODY = /\.json\(\)|\.body\b|\.formData\(\)/;
const isBody = (arg: Node | undefined): boolean => {
  if (arg === undefined) return false;
  const definition = Node.isIdentifier(arg) ? arg.getDefinitionNodes()[0] : undefined;
  return BODY.test(arg.getText()) || (Node.isVariableDeclaration(definition) && BODY.test(definition.getInitializer()?.getText() ?? ''));
};
export const parsedSchemas = (fn: Node): Node[] =>
  fn.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((call) => {
    const callee = call.getExpression();
    return Node.isPropertyAccessExpression(callee) && /^(safe)?[pP]arse(Async)?$/.test(callee.getName()) && isBody(call.getArguments()[0]) ? [callee.getExpression()] : [];
  });

// The fields of a class-validator DTO: each decorated property, its own and its base classes', with its type as
// written and its decorators as rules (IsEmail(), MinLength(8)); @IsOptional() or "?" makes it optional.
export function dtoFields(declaration: Node, depth = 0): Field[] | undefined {
  if (!Node.isClassDeclaration(declaration) || depth > 4) return undefined;
  const base = declaration.getBaseClass();
  const inherited = base === undefined ? [] : (dtoFields(base, depth + 1) ?? []);
  const own = declaration.getProperties().flatMap((property) => {
    // Validation rules only: @ApiProperty (docs) or @Transform says nothing about what the body must hold.
    const validating = property.getDecorators().filter((decorator) => {
      const call = decorator.getCallExpression();
      const id = call === undefined ? decorator.getExpression() : call.getExpression();
      return Node.isIdentifier(id) && importOf(id)?.module === 'class-validator';
    });
    const decorators = validating.map((decorator) => decorator.getText().slice(1).replace(/\s+/g, ' '));
    if (decorators.length === 0) return [];
    const optional = property.hasQuestionToken() || decorators.some((rule) => /^IsOptional\b/.test(rule));
    return [{ name: property.getName(), type: property.getTypeNode()?.getText() ?? 'any', required: !optional, rules: decorators.filter((rule) => !/^IsOptional\b/.test(rule)) }];
  });
  const names = new Set(own.map((field) => field.name));
  return [...inherited.filter((field) => !names.has(field.name)), ...own];
}

// The request-schema node for a schema a route validates, or undefined when the expression is not a schema.
export function schemaNode(resolver: Resolver, graph: GraphBuilder, expression: Node, env?: Env): string | undefined {
  const declaration = resolver.declaration(expression, env);
  if (declaration === undefined || !isSchema(declaration)) return undefined;
  const name = qualifiedName(declaration) ?? declaration.getText();
  const fields = zodFields(declaration) ?? dtoFields(declaration);
  return graph.add(keyOf(declaration), { kind: 'request-schema', name, ...resolver.where(declaration), attrs: { name, ...(fields === undefined || fields.length === 0 ? {} : { fields }) } });
}
