import type { Lookup } from '../graph/lookup.ts';
import type { GraphNode } from '../graph/schema.ts';
import type { Evidence } from '../model/evidence.ts';
import type { Flow } from '../model/flow.ts';

// Every text the engine writes is built here from graph nodes, so the verifier can rebuild it and compare
// (PLAN.md Phase 4: a claim equal to its template is proven by rule).

type Step = Flow['steps'][number];

export const evidenceOf = (node: GraphNode): Evidence => ({ type: 'code', node_id: node.id, ref: `${node.file}:${node.line}` });

export function label(node: GraphNode): string {
  switch (node.kind) {
    case 'page':
    case 'layout':
      return node.attrs.path;
    case 'route':
    case 'api-call':
      return `${node.attrs.method} ${node.attrs.path}`;
    case 'form':
    case 'response':
      return node.id.split(':').slice(2).join(':');
    default:
      return node.attrs.name;
  }
}

// For the Decider's input: "LoginForm#form" -> "login form", "submitCreateGame" -> "submit create game".
export const words = (identifier: string): string =>
  identifier
    .replace(/#form\d*$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[#._@-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const OWNERS = new Set(['component', 'page', 'layout']);

// Names and step texts say what a person sees and does, never an identifier or a file path: the button's text first,
// then the action's own words, then what the form or component is about.
const GENERIC_TEXT = /^(save|submit|ok|send|go|confirm|continue|apply|update|done|yes|no|cancel|delete|remove)$/i;
const genericAction = (name: string) => /#|^(handle|on)[A-Z_]|^(submit|action|handler)$/.test(name);
// Words a phrase can start with to say what a user does; anything else is a label to press ("Prev", "New post").
const VERBS = new Set(
  ('accept add apply approve archive book buy cancel change checkout choose clear close comment confirm connect continue copy create ' +
    'decline delete disable dismiss download duplicate edit enable export filter follow generate get go hide import invite join leave like load ' +
    'log login logout manage mark move open order pay pin post preview print proceed publish rate redirect refresh register reject remove rename ' +
    'reply report request reset restore retry save schedule search select send set share show sign signin signout signup sort start stop ' +
    'submit subscribe switch sync toggle track try undo unfollow unsubscribe update upgrade upload verify view vote watch').split(' '),
);
const startsWithVerb = (phrase: string) => VERBS.has(phrase.split(' ')[0].toLowerCase());
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const list = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
// A label in Title Case ("Sign Out", "Invite Member") said as a sentence; "Sign in with GitHub" keeps its name.
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'up', 'with']);
const spoken = (text: string) => {
  const main = text.split(' ').filter((word) => !SMALL.has(word.toLowerCase()));
  const title = main.length > 1 && main.every((word) => /^[A-Z0-9]/.test(word));
  return text
    .split(' ')
    .map((word, i) => (/^[A-Z][a-z]+$/.test(word) && (i === 0 || title) ? word.toLowerCase() : word))
    .join(' ');
};
// "ProfileForm#form" -> "profile", "AddToCartButton" -> "add to cart", "PostOperations" -> "post": what it is about,
// without the words for its UI parts.
const subject = (node: GraphNode) =>
  words(label(node).replace(/@.*$/, ''))
    .replace(/\b(form|page|button|component|section|dialog|modal|action|on click|onclick|card|skeleton|selector|operations|wrapper|container|client|panel)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
// The label a person presses: a formAction button's own, else the form's submit button, else the clicked element's.
const shown = (act: readonly (GraphNode | undefined)[]) => {
  const [first, second] = act;
  if (first?.kind === 'form') return (second?.kind === 'action' ? second.attrs.text : undefined) ?? first.attrs.submit;
  return first?.kind === 'action' ? first.attrs.text : undefined;
};

// A label a person presses, as what they do: "Sign Out" -> "sign out", "Prev" -> "press Prev".
export const pressing = (text: string): string => (startsWithVerb(text) ? spoken(text) : `press ${text}`);

// A UI step's action as data: the fields a form asks for and the button pressed, each with a selector a test tool can
// use as is ([name="email"]; Playwright's role=button[name="Sign in"]).
export function actionOf(act: readonly GraphNode[]): Flow['steps'][number]['action'] {
  const [first] = act;
  if (first?.kind !== 'form' && first?.kind !== 'action') return undefined;
  const text = shown(act);
  return {
    kind: first.kind === 'form' ? 'submit' : 'click',
    fields: first.kind === 'form' ? first.attrs.fields.map((name) => ({ name, selector: `[name="${name}"]` })) : [],
    ...(text === undefined ? {} : { button: { text, selector: `role=button[name="${text.replace(/"/g, '\\"')}"]` } }),
  };
}

// A flow's name says what a user can do, in plain words; the page or route it starts at is shown under the name, so
// it isn't repeated in it.
export const userCan = (doing: string): string => `User can ${doing}`;

// What a page is, in words: "/" -> "the home page", "/account/orders" -> "the account orders page",
// "/products/[id]" -> "product details", "/docs/[...slug]" -> "the docs pages".
export function pageTitle(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment));
  const last = segments.at(-1);
  if (last === undefined) return 'the home page';
  const named = segments.filter((segment) => !/^[[:]/.test(segment)).map((segment) => segment.replace(/[-_]+/g, ' '));
  if (/^\[\[?\.\.\./.test(last)) return named.length === 0 ? 'any page by its path' : `the ${named.join(' ')} pages`;
  if (/^[[:]/.test(last)) {
    const noun = (named.at(-1) ?? 'item').replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
    return `${[...named.slice(0, -1), noun].join(' ')} details`;
  }
  return `the ${named.join(' ')} page`;
}

// What a person does in a form or a click, as they'd say it after "User can": "sign in", "cancel order", "save
// profile", "press Prev" (a label that isn't a verb is pressed, as written).
export function actName(act: readonly GraphNode[]): string | undefined {
  const [first, second] = act;
  const action = [first, second].find((node) => node?.kind === 'action');
  const text = shown(act);
  const did = action?.kind === 'action' && !genericAction(action.attrs.name) ? words(action.attrs.name).replace(/ (action|handler)$/, '') : '';
  const about = first === undefined ? '' : subject(first.kind === 'action' && second !== undefined ? second : first);
  const phrase = (doing: string) => (startsWithVerb(doing) ? doing : `use ${doing}`);
  if (text !== undefined && !GENERIC_TEXT.test(text)) return pressing(text);
  if (did !== '') return phrase(did);
  if (text !== undefined) return about === '' ? spoken(text) : `${spoken(text)} ${about}`;
  if (about === '') return undefined;
  return startsWithVerb(about) ? about : first?.kind === 'form' ? `submit the ${about} form` : `use ${about}`;
}

// A generated Log-in step starts with this; a subflow step a person makes says which flow it runs.
export const LOGIN_CLAIM = 'Log in first:';
export const runClaim = (name: string): string => `Run "${name}"`;
export const isRunClaim = (claim: string): boolean => /^Run ".+"$/.test(claim);

// The template claim for a step citing these nodes (in this order), or undefined when they fit none.
export function claimOf(kind: Step['kind'], nodes: readonly GraphNode[]): string | undefined {
  if (kind === 'subflow') return nodes.length > 0 && nodes.every((node) => node.kind === 'guard') ? `${LOGIN_CLAIM} guarded by ${nodes.map(label).join(', ')}` : undefined;
  const [first, second, ...rest] = nodes;
  if (first === undefined || rest.length > 0) return undefined;
  if (kind === 'ui' && first.kind === 'page' && second === undefined) return `Open ${label(first)}`;
  if (kind === 'ui' && first.kind === 'form' && (second === undefined || second.kind === 'action')) {
    const text = shown([first, second]);
    const press = text === undefined ? `submit the ${subject(first) || 'form'}${subject(first) === '' ? '' : ' form'}` : `press ${text}`;
    return first.attrs.fields.length > 0 ? `Fill in ${list(first.attrs.fields)}, then ${press}` : capital(press);
  }
  if (kind === 'ui' && first.kind === 'action' && second !== undefined && OWNERS.has(second.kind)) {
    return first.attrs.text === undefined ? `Click in ${subject(second) || 'the page'} to ${actName([first, second]) ?? 'act'}` : `Press ${first.attrs.text}`;
  }
  if (kind === 'api' && first.kind === 'api-call' && second === undefined) return `Calls ${label(first)}`;
  if (kind === 'api' && first.kind === 'route' && (second === undefined || second.kind === 'handler')) {
    // An inline handler is named after its route, so naming it again says nothing.
    return `Call ${label(first)}${second === undefined || label(second) === label(first) ? '' : ` (handled by ${label(second)})`}`;
  }
  return undefined;
}

// What a node is, as a sentence: the premise when a claim is checked against evidence that fits no template.
export function sentence(node: GraphNode): string {
  switch (node.kind) {
    case 'form':
      return `The form ${label(node)}${node.attrs.fields.length > 0 ? ` with the fields ${node.attrs.fields.join(', ')}` : ''}.`;
    case 'action':
      return `The ${node.attrs.server ? 'server action' : 'action'} ${label(node)}.`;
    case 'api-call':
      return `A call to ${label(node)}.`;
    case 'response':
      return `A response with status ${node.attrs.status ?? 'unknown'}${node.attrs.fields.length > 0 ? ` and the fields ${node.attrs.fields.join(', ')}` : ''}.`;
    default:
      return `The ${node.kind} ${label(node)}.`;
  }
}

export const premiseOf = (kind: Step['kind'], nodes: readonly GraphNode[]): string => claimOf(kind, nodes) ?? nodes.map(sentence).join(' ');

const nodesOf = (step: Step, graph: Lookup): GraphNode[] => step.evidence.flatMap((item) => (item.type === 'code' ? (graph.node(item.node_id) ?? []) : []));

// The parts every flow is named and classified by: its entry (page or route), the step the user acts in, its API call.
export function shape(flow: Pick<Flow, 'steps'>, graph: Lookup) {
  const steps = flow.steps.filter((step) => step.kind !== 'subflow').map((step) => ({ step, nodes: nodesOf(step, graph) }));
  const entry = steps[0]?.nodes[0];
  const act = steps.find(({ step, nodes }) => step.kind === 'ui' && (nodes[0]?.kind === 'form' || nodes[0]?.kind === 'action'));
  const call = act === undefined ? undefined : steps.slice(steps.indexOf(act) + 1).find(({ step }) => step.kind === 'api')?.nodes[0];
  return { entry, act: act?.nodes ?? [], call };
}

// The template name, or undefined when the flow doesn't start at a page or a route.
export function flowName(flow: Pick<Flow, 'steps'>, graph: Lookup): string | undefined {
  const { entry, act, call } = shape(flow, graph);
  if (entry?.kind === 'route') return label(entry);
  if (entry?.kind !== 'page') return undefined;
  // One action that can make several calls is a flow per call: only then does the call tell them apart.
  const action = act.find((node) => node.kind === 'action');
  const which = action !== undefined && call !== undefined && graph.out(action.id, 'calls').length > 1 ? ` (${label(call)})` : '';
  if (act[0]?.kind === 'form') return `${userCan(actName(act) ?? 'submit a form')}${which}`;
  if (act[0]?.kind === 'action') return `${userCan(actName(act) ?? 'use the page')}${which}`;
  return userCan(`view ${pageTitle(label(entry))}`);
}

// One line per flow for the Decider (destructive-risk, flow-category), in the format of the tasks' examples.
export function deciderText(flow: Pick<Flow, 'steps'>, graph: Lookup): string {
  const { entry, act, call } = shape(flow, graph);
  if (entry?.kind === 'route') {
    const handler = graph.out(entry.id, 'handled-by')[0];
    return `${label(entry)}${handler === undefined || label(handler) === label(entry) ? '' : ` -> ${words(label(handler))}`}`;
  }
  const page = entry === undefined ? '' : ` on ${label(entry)}`;
  const then = call === undefined ? '' : ` -> ${label(call)}`;
  const [first, second] = act;
  if (first?.kind === 'form') {
    return `form: ${words(label(first))} (${first.attrs.fields.map(words).join(', ')})${second === undefined ? '' : ` -> ${words(label(second))}`}${then}${page}`;
  }
  if (first?.kind === 'action') return `click: ${words(label(first))}${then}${page}`;
  // A view: what the page renders, and what it calls on load (a load call can change data too).
  const parts = entry === undefined ? [] : graph.out(entry.id, 'renders').map((node) => words(label(node)));
  const loads = flow.steps.flatMap((step) => (step.kind === 'api' && step.request !== undefined ? [`${step.request.method} ${step.request.path}`] : []));
  return `page: ${entry === undefined ? '?' : label(entry)}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}${loads.length > 0 ? ` -> ${loads.join(', ')}` : ''}`;
}
