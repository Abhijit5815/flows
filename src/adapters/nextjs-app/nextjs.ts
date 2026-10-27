import { readFileSync } from 'node:fs';
import { Node, SyntaxKind } from 'ts-morph';
import { z } from 'zod';
import { PatternRuleSchema } from '../../ingest/match.ts';
import { holderOf, importOf, inProject, isFunctionLike, keyOf, NO_ENV, qualifiedName, type Env } from '../../ingest/resolve.ts';
import { HTTP_METHODS } from '../../model/flow.ts';
import type { ExtractContext, FrameworkAdapter, Unrecognised } from '../adapter.ts';

// Next.js 14 App Router: pages and layouts come from the app/ folder's file conventions; components, forms,
// actions and API calls are followed from each page with the resolver. The rules (rules.json) find every API call
// site, so calls that no page reaches are reported.
const RULES = z.object({ patterns: z.array(PatternRuleSchema), suspects: z.array(PatternRuleSchema) }).parse(JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8')));

const ROUTE_FILE = /^(page|layout|route)\.(tsx|ts|jsx|js)$/;
const FORM_STATE_HOOKS = new Set(['useFormState', 'useActionState']);
const AXIOS_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const MAX_CALL_DEPTH = 3;
const AUTH_CALL = /^(signIn|signOut|signUp|logIn|logOut|login|logout)$/;
// A button's working or done state, not what it does: "Saving...", "Loading…", "Copied", "Saved!".
const STATE_LABEL = /(\.\.\.|…)$|^(copied|saved|sent|added|removed|deleted|updated|submitted|subscribed|followed|liked|joined|done)!?$/i;

const isGroup = (segment: string) => /^\(.+\)$/.test(segment) && !/^\(\.{1,3}\)/.test(segment);
const isParallelOrIntercepting = (segment: string) => segment.startsWith('@') || /^\(\.{1,3}\)/.test(segment);

// "/(shop)/products/[id]" -> "/products/[id]": route groups add nothing to the URL.
const normalise = (segments: readonly string[]) => `/${segments.join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
export const routePath = (segments: readonly string[]): string => normalise(segments.filter((segment) => !isGroup(segment)));

// Next.js middleware matchers: path-to-regexp style ("/account/:path*"), or a regular expression when they hold a group.
export function matcherRegex(matcher: string): RegExp {
  if (matcher.includes('(')) return new RegExp(`^${matcher}$`);
  const source = matcher
    .replace(/\./g, '\\.')
    .replace(/\/:\w+\*/g, '(?:/.*)?')
    .replace(/\/:\w+\+/g, '(?:/.+)')
    .replace(/\/:\w+\?/g, '(?:/[^/]+)?')
    .replace(/:\w+/g, '[^/]+');
  return new RegExp(`^${source}$`);
}

// A concrete URL a page answers, to test against matchers: /products/[id] -> /products/x.
const samplePath = (path: string) => path.replace(/\[\[?\.\.\.\w+\]\]?/g, 'x/y').replace(/\[\w+\]/g, 'x');

const hasDirective = (statements: readonly Node[], directive: string) => {
  const first = statements[0];
  return Node.isExpressionStatement(first) && Node.isStringLiteral(first.getExpression()) && first.getExpression().getText().slice(1, -1) === directive;
};

// A server action: 'use server' at the top of its file or of its own body.
function isServerAction(fn: Node): boolean {
  if (hasDirective(fn.getSourceFile().getStatements(), 'use server')) return true;
  const body = Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) ? fn.getBody() : undefined;
  return Node.isBlock(body) && hasDirective(body.getStatements(), 'use server');
}

function extract({ files, facts, resolver, graph }: ExtractContext): Unrecognised[] {
  const notes: Unrecognised[] = [];
  const appDir = files.some((file) => file.startsWith('app/')) ? 'app' : 'src/app';

  // A project function a call reaches, by its declaration (no evaluation of the call's arguments).
  const calledFunction = (callee: Node): Node | undefined => {
    const name = Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee;
    const declaration = Node.isIdentifier(name) ? name.getDefinitionNodes()[0] : undefined;
    const fn = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : declaration;
    return fn !== undefined && isFunctionLike(fn) && inProject(fn) ? fn : undefined;
  };

  // The path part of a URL: a leading base (API_URL) is dropped except for its own path; unknown parts become :name.
  const baseOf = (expression: Node, env: Env): string => {
    const fixed = resolver.string(expression, env);
    const candidates = fixed !== undefined ? [fixed] : resolver.values(expression, env).flatMap((value) => resolver.string(value, env) ?? []);
    const absolute = [...new Set(candidates.filter((candidate) => /^https?:\/\//.test(candidate)))];
    if (absolute.length === 1) return new URL(absolute[0]).pathname;
    return fixed !== undefined && fixed.startsWith('/') ? fixed : '';
  };
  const part = (expression: Node, env: Env): string => {
    const fixed = resolver.string(expression, env);
    if (fixed !== undefined) return fixed;
    const name = Node.isPropertyAccessExpression(expression) ? expression.getName() : Node.isIdentifier(expression) ? expression.getText() : 'param';
    return `:${name}`;
  };
  const tidy = (path: string) => {
    const bare = path.replace(/[?#].*$/, '').replace(/\/{2,}/g, '/');
    return bare.length > 1 ? bare.replace(/\/$/, '') : bare || '/';
  };
  const urlPath = (url: Node, env: Env, depth = 0): string | undefined => {
    if (Node.isTemplateExpression(url)) {
      const spans = url.getTemplateSpans();
      const head = url.getHead().getLiteralText();
      const based = head === '' && spans.length > 0;
      let path = based ? baseOf(spans[0].getExpression(), env) + spans[0].getLiteral().getLiteralText() : head;
      for (const span of spans.slice(based ? 1 : 0)) path += part(span.getExpression(), env) + span.getLiteral().getLiteralText();
      return tidy(path);
    }
    if (Node.isBinaryExpression(url) && url.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      return tidy(baseOf(url.getLeft(), env) + (resolver.string(url.getRight(), env) ?? part(url.getRight(), env)));
    }
    if (Node.isStringLiteral(url) || Node.isNoSubstitutionTemplateLiteral(url)) {
      const text = url.getLiteralValue();
      return /^https?:\/\//.test(text) ? text.replace(/[?#].*$/, '') : tidy(text); // a literal full URL is another service
    }
    if (depth > 3) return undefined;
    for (const value of resolver.values(url, env)) {
      if (value === url || !Node.isExpression(value)) continue;
      const path = urlPath(value, env, depth + 1);
      if (path !== undefined) return path;
    }
    return undefined;
  };

  const methodOf = (init: Node | undefined, env: Env): string => {
    const options = init === undefined ? undefined : resolver.values(init, env).find((value) => Node.isObjectLiteralExpression(value));
    const property = Node.isObjectLiteralExpression(options) ? options.getProperty('method') : undefined;
    const method = Node.isPropertyAssignment(property) ? resolver.string(property.getInitializerOrThrow(), env)?.toUpperCase() : undefined;
    return method !== undefined && (HTTP_METHODS as readonly string[]).includes(method) ? method : 'GET';
  };

  // fetch(url, { method }) and axios.<method>(url): an API call node per file, method and path.
  const reached = new Set<string>();
  const apiCall = (call: Node, env: Env): string | undefined => {
    if (!Node.isCallExpression(call)) return undefined;
    const callee = call.getExpression();
    const [url, second] = call.getArguments();
    let method: string | undefined;
    if (Node.isIdentifier(callee) && callee.getText() === 'fetch' && calledFunction(callee) === undefined) method = methodOf(second, env);
    if (Node.isPropertyAccessExpression(callee) && AXIOS_METHODS.has(callee.getName())) {
      const object = callee.getExpression();
      if (Node.isIdentifier(object) && importOf(object)?.module === 'axios') method = callee.getName().toUpperCase();
    }
    if (method === undefined || url === undefined) return undefined;
    reached.add(keyOf(call));
    const path = urlPath(url, env) ?? '?';
    const where = resolver.where(call);
    return graph.add(`api-call:${where.file}:${method} ${path}`, { kind: 'api-call', name: `${method} ${path}`, ...where, attrs: { method, path } });
  };

  // API calls a function makes, itself or through project functions it calls (lib/api.ts helpers), whose
  // parameters are bound to the arguments so `${API_URL}${path}` wrappers resolve. Calls inside `skip` belong to
  // actions and are counted there.
  // shortcut: nothing is memoised, so a function reached from many pages is walked again each time; memoise if scans get slow.
  const apiCallsIn = (fn: Node, env: Env, depth: number, skip: ReadonlySet<Node>, stack: readonly Node[] = []): string[] =>
    fn.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((call) => {
      if (skip.size > 0 && call.getFirstAncestor((ancestor) => skip.has(ancestor)) !== undefined) return [];
      const found = apiCall(call, env);
      if (found !== undefined) return [found];
      const target = depth < MAX_CALL_DEPTH ? calledFunction(call.getExpression()) : undefined;
      if (target === undefined || target === fn || stack.includes(target)) return [];
      return apiCallsIn(target, resolver.bindParameters(target, call.getArguments(), env), depth + 1, new Set(), [...stack, fn]);
    });

  // What a form or button attribute runs: a function, a server action bound with .bind(), or the action behind a
  // useFormState / useActionState dispatch.
  const actionTargets = (expression: Node, depth = 0): Node[] => {
    if (depth > 4) return [];
    if (Node.isIdentifier(expression)) {
      const definition = expression.getDefinitionNodes()[0];
      const pattern = definition?.getParent();
      const holder = pattern?.getParent();
      const init = Node.isVariableDeclaration(holder) ? holder.getInitializer() : undefined;
      if (Node.isBindingElement(definition) && Node.isArrayBindingPattern(pattern) && pattern.getElements().indexOf(definition) === 1 && Node.isCallExpression(init)) {
        const hook = init.getExpression();
        const name = Node.isIdentifier(hook) ? importOf(hook)?.name : undefined;
        if (name !== undefined && FORM_STATE_HOOKS.has(name) && init.getArguments()[0] !== undefined) return actionTargets(init.getArguments()[0], depth + 1);
      }
    }
    return resolver.values(expression).flatMap((value) => {
      if (Node.isCallExpression(value)) {
        const callee = value.getExpression();
        return Node.isPropertyAccessExpression(callee) && callee.getName() === 'bind' ? actionTargets(callee.getExpression(), depth + 1) : [];
      }
      return isFunctionLike(value) && inProject(value) ? [value] : [];
    });
  };

  // What an action ends in, from its own body: where it sends the browser (redirect('/account'), router.push('/x'))
  // and the strings it returns for its form to show ('Wrong email or password.').
  const outcomesOf = (fn: Node): { redirects?: string[]; messages?: string[] } => {
    const redirects = fn.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((call) => {
      const callee = call.getExpression();
      const imported = Node.isIdentifier(callee) ? importOf(callee) : undefined;
      const object = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;
      const navigates =
        (imported?.module === 'next/navigation' && (imported.name === 'redirect' || imported.name === 'permanentRedirect')) ||
        (Node.isPropertyAccessExpression(callee) && ['push', 'replace'].includes(callee.getName()) && Node.isIdentifier(object) && /\buseRouter\(/.test(object.getDefinitionNodes()[0]?.getText() ?? ''));
      const path = navigates && call.getArguments()[0] !== undefined ? resolver.string(call.getArguments()[0]) : undefined;
      return path?.startsWith('/') ? [path] : [];
    });
    const messages = fn.getDescendantsOfKind(SyntaxKind.ReturnStatement).flatMap((statement) => {
      const value = statement.getExpression();
      const own = statement.getFirstAncestor((ancestor) => isFunctionLike(ancestor)) === fn;
      return own && (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) ? [value.getLiteralValue()] : [];
    });
    // An auth library's sign-in or sign-out reaches the server inside the library (next-auth's signOut(), better-auth's
    // authClient.signIn.social(...), supabase.auth.signOut()): named by the call, when it isn't the app's own function.
    const library = fn.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((call) => {
      const callee = call.getExpression();
      const names: string[] = [];
      let link: Node = callee;
      while (Node.isPropertyAccessExpression(link)) {
        names.push(link.getName());
        link = link.getExpression();
      }
      if (Node.isIdentifier(link)) names.push(link.getText());
      return names.some((name) => AUTH_CALL.test(name)) && calledFunction(callee) === undefined ? [callee.getText()] : [];
    })[0];
    return {
      ...(redirects.length > 0 ? { redirects: [...new Set(redirects)] } : {}),
      ...(messages.length > 0 ? { messages: [...new Set(messages)] } : {}),
      ...(library === undefined ? {} : { library }),
    };
  };

  // An inline handler has no name of its own, so it is named after its component: "Header#action", "GamePage#onClick2".
  // text: what the element that runs it says ("Add to cart"), from the first place it is found.
  const addAction = (fn: Node, inlineName: () => string, text?: string): string => {
    const holder = holderOf(fn);
    const key = keyOf(holder);
    if (graph.get(key) !== undefined) return key;
    const name = qualifiedName(holder) ?? inlineName();
    graph.add(key, { kind: 'action', name, ...resolver.where(holder), attrs: { name, server: isServerAction(fn), ...outcomesOf(fn), ...(text === undefined ? {} : { text }) } });
    for (const call of new Set(apiCallsIn(fn, NO_ENV, 0, new Set()))) graph.edge(key, call, 'calls');
    return key;
  };

  const attribute = (element: Node, name: string): Node | undefined => {
    if (!Node.isJsxOpeningElement(element) && !Node.isJsxSelfClosingElement(element)) return undefined;
    const found = element.getAttribute(name);
    const initializer = Node.isJsxAttribute(found) ? found.getInitializer() : undefined;
    return Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
  };

  const jsxElements = (root: Node): Node[] => root.getDescendants().filter((node) => Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node));
  const tagOf = (element: Node) => (Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element) ? element.getTagNameNode() : element);
  const componentsOf = (element: Node): Node[] =>
    /^[a-z]/.test(tagOf(element).getText()) ? [] : resolver.values(tagOf(element)).filter((value) => (isFunctionLike(value) || Node.isClassDeclaration(value)) && inProject(value));

  // What an element says to the user: its text (<button>Sign in</button>, or the idle branch of {pending ? 'Saving...' :
  // 'Save'}), an input's value, then its aria-label or title (an icon button), then the text of the button a component
  // like <SubmitButton /> renders. Only fixed text: a label built at run time says nothing here.
  const textOf = (element: Node, depth = 0): string | undefined => {
    const fixed = (name: string) => {
      const value = attribute(element, name);
      return value === undefined ? undefined : resolver.string(value);
    };
    const body = Node.isJsxOpeningElement(element) ? element.getParent() : undefined;
    // Shown text only: not a class name in an attribute, not 'signin' in mode === 'signin', and of {a ? 'X' : 'Y'} the
    // first branch (the second when the first is a "Saving..." label).
    const literal = (node: Node): string[] => {
      if (Node.isJsxText(node)) return [node.getText()];
      if (!(Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))) return [];
      if (node.getFirstAncestor((ancestor) => Node.isJsxAttribute(ancestor)) !== undefined || node.getFirstAncestor((ancestor) => Node.isJsxExpression(ancestor)) === undefined) return [];
      let branch: Node = node;
      let parent = node.getParent();
      while (Node.isParenthesizedExpression(parent)) [branch, parent] = [parent, parent.getParent()];
      if (Node.isBinaryExpression(parent) || Node.isCallExpression(parent)) return [];
      if (Node.isConditionalExpression(parent) && parent.getWhenFalse() === branch) {
        let first = parent.getWhenTrue();
        while (Node.isParenthesizedExpression(first)) first = first.getExpression();
        if ((Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) && !STATE_LABEL.test(first.getLiteralValue())) return [];
      }
      return [node.getLiteralValue()];
    };
    // "Saving..." is what a button says while it works, not what it does.
    // "Saving..." or "Copied" is what a button says while it works or once it has, not what it does.
    const parts = (Node.isJsxElement(body) ? body.getDescendants().flatMap(literal) : [fixed('value') ?? '']).map((part) => part.trim()).filter((part) => part !== '' && !STATE_LABEL.test(part));
    const own = parts.join(' ').replace(/\s+/g, ' ').trim();
    const component = depth === 0 && own === '' ? componentsOf(element)[0] : undefined;
    const text = own || fixed('aria-label') || fixed('title') || (component === undefined ? undefined : submitText(component, depth + 1));
    return text !== undefined && text.length > 0 && text.length <= 60 ? text : undefined;
  };

  // The text of a form's submit button: a <button> that isn't type="button" or "reset", an <input type="submit">, or a
  // component whose name says button (<SubmitButton>Sign in</SubmitButton>).
  const submitText = (body: Node, depth = 0): string | undefined =>
    jsxElements(body)
      .filter((element) => {
        const tag = tagOf(element).getText();
        const type = attribute(element, 'type');
        const kind = type === undefined ? undefined : resolver.string(type);
        // A button marked disabled outright is a state ("Out Of Stock"), not what the form does.
        const disabled = Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element) ? element.getAttribute('disabled') : undefined;
        if (Node.isJsxAttribute(disabled) && (disabled.getInitializer() === undefined || disabled.getInitializer()?.getText() === '{true}')) return false;
        return (tag === 'button' && kind !== 'button' && kind !== 'reset') || (tag === 'input' && kind === 'submit') || (/^[A-Z]/.test(tag) && /button/i.test(tag));
      })
      .map((element) => textOf(element, depth))
      .find((text) => text !== undefined);

  // A form's field names, including inputs of components rendered inside it (<Login /> inside an auth form).
  const fieldsIn = (root: Node, seen: Set<Node>): string[] =>
    jsxElements(root).flatMap((element) => {
      const name = attribute(element, 'name');
      const value = name === undefined ? undefined : resolver.string(name);
      const nested = componentsOf(element).filter((component) => !seen.has(component));
      for (const component of nested) seen.add(component);
      return [...(value === undefined ? [] : [value]), ...nested.flatMap((component) => fieldsIn(component, seen))];
    });

  // The prop a component's own attribute passes on: action={action} from ({ action }) or props.action from (props).
  const propOf = (value: Node, fn: Node): string | undefined => {
    const name = Node.isPropertyAccessExpression(value) ? value.getExpression() : value;
    const definition = Node.isIdentifier(name) ? name.getDefinitionNodes()[0] : undefined;
    if (Node.isBindingElement(definition) && definition.getFirstAncestor((ancestor) => Node.isParameterDeclaration(ancestor))?.getParent() === fn) {
      return definition.getPropertyNameNode()?.getText() ?? definition.getName();
    }
    return Node.isParameterDeclaration(definition) && definition.getParent() === fn && Node.isPropertyAccessExpression(value) ? value.getName() : undefined;
  };

  // A form component that takes what it runs as a prop (<Form action={register}>): a form of its own on each page that
  // uses it, with the action that page passes, so two pages sharing it are two flows.
  const propForms = new Map<Node, { props: string[]; fields: string[]; submit?: string }[]>();

  // Walks one page, layout or component: what it renders, its forms and click actions, and what it fetches.
  const visited = new Set<string>();
  const visit = (key: string, fn: Node, owner: string): void => {
    const handlers = new Set<Node>();
    const counts = new Map<string, number>();
    const inline = (via: string) => () => {
      const n = (counts.get(via) ?? 0) + 1;
      counts.set(via, n);
      return `${owner}#${via}${n > 1 ? n : ''}`;
    };
    let forms = 0;
    for (const element of jsxElements(fn)) {
      const tag = tagOf(element).getText();
      const onClick = attribute(element, 'onClick');
      for (const target of onClick === undefined ? [] : actionTargets(onClick)) {
        handlers.add(target);
        graph.edge(key, addAction(target, inline('onClick'), textOf(element)), 'triggers');
      }
      if (tag === 'form' && Node.isJsxOpeningElement(element)) {
        const body = element.getParentOrThrow();
        const fields = [...new Set(fieldsIn(body, new Set()))];
        const props = ['action', 'onSubmit'].flatMap((name) => {
          const value = attribute(element, name);
          const prop = value === undefined ? undefined : propOf(value, fn);
          return prop === undefined ? [] : [prop];
        });
        const submit = submitText(body);
        if (props.length > 0) {
          propForms.set(fn, [...(propForms.get(fn) ?? []), { props, fields, ...(submit === undefined ? {} : { submit }) }]);
          continue;
        }
        forms += 1;
        const name = `${owner}#form${forms > 1 ? forms : ''}`;
        const form = graph.add(keyOf(element), { kind: 'form', name, ...resolver.where(element), attrs: { fields, ...(submit === undefined ? {} : { submit }) } });
        graph.edge(key, form, 'contains');
        const targets = [
          ...['action', 'onSubmit'].flatMap((name) => {
            const value = attribute(element, name);
            return value === undefined ? [] : actionTargets(value).map((target) => ({ target, name, text: undefined as string | undefined }));
          }),
          ...jsxElements(body).flatMap((inner) => {
            const value = attribute(inner, 'formAction');
            return value === undefined ? [] : actionTargets(value).map((target) => ({ target, name: 'formAction', text: textOf(inner) }));
          }),
        ];
        for (const { target, name: via, text } of targets) {
          handlers.add(target);
          graph.edge(form, addAction(target, inline(via), text), 'submits');
        }
        continue;
      }
      for (const component of componentsOf(element)) {
        if (component === fn) continue;
        const holder = holderOf(component);
        const name = qualifiedName(holder) ?? tag;
        const child = graph.add(keyOf(holder), { kind: 'component', name, ...resolver.where(holder), attrs: { name } });
        graph.edge(key, child, 'renders');
        if (!visited.has(child)) {
          visited.add(child);
          visit(child, component, name);
        }
        for (const shared of propForms.get(component) ?? []) {
          const targets = shared.props.flatMap((prop) => {
            const value = attribute(element, prop);
            return value === undefined ? [] : actionTargets(value).map((target) => ({ target, via: prop }));
          });
          if (targets.length === 0) continue;
          forms += 1;
          const body = Node.isJsxOpeningElement(element) ? element.getParentOrThrow() : element;
          const fields = [...new Set([...shared.fields, ...fieldsIn(body, new Set())])];
          const submit = submitText(body) ?? shared.submit;
          const form = graph.add(`${keyOf(element)}#form`, { kind: 'form', name: `${owner}#form${forms > 1 ? forms : ''}`, ...resolver.where(element), attrs: { fields, ...(submit === undefined ? {} : { submit }) } });
          graph.edge(key, form, 'contains');
          for (const { target, via } of targets) {
            handlers.add(target);
            graph.edge(form, addAction(target, inline(via)), 'submits');
          }
        }
      }
    }
    for (const call of new Set(apiCallsIn(fn, NO_ENV, 0, handlers))) graph.edge(key, call, 'calls');
  };

  // The function a page or layout file exports by default.
  const defaultExport = (path: string): Node | undefined => {
    const declaration = resolver.file(path).getDefaultExportSymbol()?.getDeclarations()[0];
    if (declaration === undefined) return undefined;
    if (Node.isExportAssignment(declaration)) return resolver.values(declaration.getExpression()).find((value) => isFunctionLike(value) && inProject(value));
    return declaration;
  };

  const pages: { key: string; path: string; folder: string[] }[] = [];
  const layouts: { key: string; folder: string[] }[] = [];
  for (const file of files) {
    if (!file.startsWith(`${appDir}/`)) continue;
    const segments = file.slice(appDir.length + 1).split('/');
    const kind = ROUTE_FILE.exec(segments.at(-1) ?? '')?.[1];
    const folder = segments.slice(0, -1);
    if (kind === undefined || folder.some((segment) => segment.startsWith('_'))) continue; // private folders are not routes
    if (kind === 'route') {
      notes.push({ file, line: 1, reason: 'route handler: API endpoints inside the Next.js app are not read in slice 1 (API flows come from the backend)' });
      continue;
    }
    if (folder.some(isParallelOrIntercepting)) {
      if (kind === 'page') notes.push({ file, line: 1, reason: 'parallel or intercepting route: not a page of its own, and not read in slice 1' });
      continue;
    }
    const fn = defaultExport(file);
    const where = fn === undefined ? { file, line: 1 } : resolver.where(holderOf(fn));
    if (kind === 'page') {
      const path = routePath(folder);
      const key = graph.add(`page:${path}`, { kind: 'page', name: path, ...where, attrs: { path } });
      pages.push({ key, path, folder });
      if (fn !== undefined) visit(key, fn, qualifiedName(holderOf(fn)) ?? path);
    } else {
      const key = graph.add(`layout:${file}`, { kind: 'layout', name: normalise(folder), ...where, attrs: { path: routePath(folder) } });
      layouts.push({ key, folder });
      if (fn !== undefined) visit(key, fn, qualifiedName(holderOf(fn)) ?? normalise(folder));
    }
  }

  // A layout wraps every page in its folder and below it.
  for (const page of pages) {
    for (const layout of layouts) {
      if (layout.folder.every((segment, i) => page.folder[i] === segment)) graph.edge(page.key, layout.key, 'wrapped-by');
    }
  }

  // middleware.ts guards the pages its matcher selects. When its logic (or a config it uses) checks
  // pathname.startsWith('/x'), only pages under those prefixes count as guarded.
  const middlewareFile = files.find((file) => /^(src\/)?middleware\.(ts|js)$/.test(file));
  if (middlewareFile !== undefined) {
    const source = resolver.file(middlewareFile);
    const declaration = source.getFunction('middleware') ?? source.getVariableDeclaration('middleware') ?? source.getDefaultExportSymbol()?.getDeclarations()[0];
    const guard = graph.add(`guard:${middlewareFile}`, { kind: 'guard', name: 'middleware', ...(declaration === undefined ? { file: middlewareFile, line: 1 } : resolver.where(declaration)), attrs: { name: 'middleware' } });
    const config = source.getVariableDeclaration('config')?.getInitializer();
    const options = config === undefined ? undefined : resolver.values(config).find((value) => Node.isObjectLiteralExpression(value));
    const matcher = Node.isObjectLiteralExpression(options) ? options.getProperty('matcher') : undefined;
    const listed = Node.isPropertyAssignment(matcher) ? resolver.values(matcher.getInitializerOrThrow()) : [];
    const patterns = listed.flatMap((value) => (Node.isArrayLiteralExpression(value) ? value.getElements() : [value])).flatMap((value) => resolver.string(value) ?? []);
    const scopes = [source, ...source.getDescendantsOfKind(SyntaxKind.Identifier).flatMap((identifier) => {
      const definition = identifier.getDefinitionNodes()[0];
      return definition !== undefined && inProject(definition) && definition.getSourceFile() !== source ? [definition] : [];
    })];
    const prefixes = scopes.flatMap((scope) => scope.getDescendantsOfKind(SyntaxKind.CallExpression)).flatMap((call) => {
      const callee = call.getExpression();
      const [arg] = call.getArguments();
      return Node.isPropertyAccessExpression(callee) && callee.getName() === 'startsWith' && Node.isStringLiteral(arg) && arg.getLiteralValue().startsWith('/') ? [arg.getLiteralValue()] : [];
    });
    for (const page of pages) {
      const sample = samplePath(page.path);
      const matched = patterns.length === 0 || patterns.some((pattern) => matcherRegex(pattern).test(sample));
      const scoped = prefixes.length === 0 || prefixes.some((prefix) => sample === prefix || sample.startsWith(`${prefix.replace(/\/$/, '')}/`));
      if (matched && scoped) graph.edge(page.key, guard, 'guarded-by');
    }
  }

  // Every API call site the rules found should be reachable from some page; the rest are listed.
  for (const [file, { facts: list }] of facts) {
    for (const fact of list) {
      const call = resolver.nodeAt(file, fact.start, fact.end);
      if (call !== undefined && !reached.has(keyOf(call))) notes.push({ file, line: fact.line, reason: `API call ${call.getText().slice(0, 60)} is not reached from any page` });
    }
  }
  return notes;
}

export const nextAppAdapter: FrameworkAdapter = {
  id: 'nextjs-app',
  role: 'web',
  // Only the App Router is supported; a Pages Router app has no app/ folder and is reported, not guessed at.
  detection: { dependency: 'next', testedMajor: 14, needsOneOf: ['app', 'src/app'] },
  rules: RULES.patterns,
  suspects: RULES.suspects,
  extract,
};
