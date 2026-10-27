import { Node, SyntaxKind } from 'ts-morph';
import { words } from '../engine/describe.ts';
import type { Resolver } from '../ingest/resolve.ts';

// What a test needs besides the route: when an error is sent, how a guard reads the session, where a login puts its
// token. Read from the code the adapters already resolve; shared by every adapter.

// "prisma.product.findUnique" -> "product", "userService.getUserById" -> "user by id": what a lookup looks up.
const LOOKUP = /(?:(\w+)\.)?(find\w*|get\w*|fetch\w*|load\w*)\s*\(/;
function looked(expression: Node | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const match = LOOKUP.exec(expression.getText());
  if (match === null) return undefined;
  const [, owner, method] = match;
  const what = words(method.replace(/^(find|get|fetch|load)(Unique|First|One|Many|All)?(OrThrow)?/, '')).replace(/^by /, '');
  return what !== '' ? what : owner !== undefined && !/service|repo|repository|client|db|prisma/i.test(owner) ? words(owner) : undefined;
}

// The condition an error is sent under: in words when it tests a lookup's result (if (!product) after findUnique is
// "no product matches"; if (existing) after one is "one already matches"), in a catch it is "something it calls
// fails", otherwise the condition as written when it is short.
export function conditionOf(site: Node): string | undefined {
  const branch = site.getFirstAncestor((ancestor) => Node.isIfStatement(ancestor) || Node.isCatchClause(ancestor) || Node.isConditionalExpression(ancestor) || ancestor === site.getSourceFile());
  if (branch === undefined || Node.isSourceFile(branch)) return undefined;
  if (Node.isCatchClause(branch)) return 'its try block throws';
  const condition = Node.isIfStatement(branch) ? branch.getExpression() : Node.isConditionalExpression(branch) ? branch.getCondition() : undefined;
  if (condition === undefined) return undefined;
  // In the else branch (if ... else, or a ? b : c) the test came out false.
  const inElse = (Node.isIfStatement(branch) ? branch.getElseStatement() : Node.isConditionalExpression(branch) ? branch.getWhenFalse() : undefined)?.containsRange(site.getPos(), site.getEnd()) ?? false;
  const negated = Node.isPrefixUnaryExpression(condition) && condition.getOperatorToken() === SyntaxKind.ExclamationToken ? condition.getOperand() : undefined;
  const name = negated ?? condition;
  const definition = Node.isIdentifier(name) ? name.getDefinitionNodes()[0] : undefined;
  const source = Node.isVariableDeclaration(definition) ? definition.getInitializer() : undefined;
  const what = looked(source);
  if (what !== undefined) return (negated !== undefined) !== inElse ? `no ${what} matches` : `${/^[aeio]/i.test(what) ? 'an' : 'a'} ${what} already matches`;
  const text = condition.getText().replace(/\s+/g, ' ');
  return text.length <= 80 ? `${inElse ? 'unless' : 'if'} (${text})` : undefined;
}

// How a guard reads the session, from its code: the Authorization header and its scheme, a cookie, or an API-key
// header. undefined when the code doesn't say.
export function carriesOf(text: string): { header?: string; scheme?: string; cookie?: string } | undefined {
  const cookie = /cookies?(?:\.get\(|\.has\(|\[|\.)\s*['"`]?([\w.-]+)/.exec(text)?.[1];
  if (/authorization|fromAuthHeader|bearer/i.test(text)) {
    const scheme = /fromAuthHeaderWithScheme\(\s*['"`](\w+)/.exec(text)?.[1] ?? /['"`](Bearer|Token|JWT)\s/.exec(text)?.[1] ?? (/fromAuthHeaderAsBearerToken|bearer/i.test(text) ? 'Bearer' : undefined);
    return { header: 'Authorization', ...(scheme === undefined ? {} : { scheme }) };
  }
  const key = /headers?(?:\[|\.get\()\s*['"`](x-[\w-]+)/i.exec(text)?.[1];
  if (key !== undefined) return { header: key };
  return cookie !== undefined && !/^(get|has|set)$/.test(cookie) ? { cookie } : undefined;
}

// Where a response body puts a login's token: the property holding jwt.sign(...) or named like a token, followed
// through nested objects and variables two levels deep ({ user: { token } } is "user.token").
const TOKEN = /^(access_?token|accessToken|token|jwt|id_?token|idToken)$/i;
export function tokenIn(body: Node | undefined, resolver: Resolver, depth = 0): string | undefined {
  if (body === undefined || depth > 2) return undefined;
  const object = Node.isObjectLiteralExpression(body) ? body : resolver.values(body).find((value) => Node.isObjectLiteralExpression(value));
  if (!Node.isObjectLiteralExpression(object)) return undefined;
  for (const property of object.getProperties()) {
    if (!Node.hasName(property)) continue;
    const value = Node.isPropertyAssignment(property) ? property.getInitializerOrThrow() : Node.isShorthandPropertyAssignment(property) ? property.getNameNode() : undefined;
    if (TOKEN.test(property.getName()) || /\bsign\(/.test(value?.getText() ?? '')) return property.getName();
    const inner = tokenIn(value, resolver, depth + 1);
    if (inner !== undefined) return `${property.getName()}.${inner}`;
  }
  return undefined;
}
