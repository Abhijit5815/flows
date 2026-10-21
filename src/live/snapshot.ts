// What one page state shows a person (PLAN.md Phase 3): visible text, links, buttons and forms, each element with
// a selector. `kit` and `snapshot` run inside the page, so they may use only the DOM: nothing imported, no helper
// from outside their own bodies. inPage() puts the kit's source next to its caller's, so the explorer's snapshot and
// the inspector's overlay find, name and select elements the same way.

// Most stable first: a test id, another test attribute, an authored id, a form field's name, the role plus the
// accessible name, and only then an XPath, which is the one kind that counts as "no stable selector". The format is
// Flows' own, not a test framework's: "testid:add-1", "attr:data-cy=save", "id:login", "name:email",
// 'role:button "Add to cart"', "xpath:/html/body/main/button[2]".
export type Element = { text: string; selector: string; stable: boolean };
export type Link = Element & { href: string };
// form: index into `forms`, when inside one. Look-alike controls are explored once: group is the XPath without any
// positions (the same "Join" on every row has one group), list the XPath without the positions of table and list
// items only (every move in a game's move table has one list, but a toolbar's buttons don't).
export type Button = Element & { role: string; form: number | null; group: string; list: string };
export type Field = { name: string; type: string; label: string; required: boolean; visible: boolean; selector: string; options: string[] };
export type Form = Element & { method: string; action: string; fields: Field[]; submit: Element | null };
export type Snapshot = { url: string; title: string; text: string; links: Link[]; buttons: Button[]; forms: Form[]; password: boolean };

export const isStable = (selector: string): boolean => !selector.startsWith('xpath:');

export const MAX_TEXT = 5000;

// The in-page helpers. Uniqueness of a role selector is counted once per kit, so make a new kit when the page changes.
export function kit() {
  const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  // Opacity doesn't hide a control: buttons that fade in on hover (a list's "Join") are there to be clicked, and a
  // closed dialog is hidden by visibility, which this checks.
  const visible = (element: globalThis.Element) => (element as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true }) ?? true;
  const count = (selector: string) => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  };

  const labelOf = (element: globalThis.Element): string => {
    const aria = clean(element.getAttribute('aria-label'));
    if (aria !== '') return aria;
    const by = element.getAttribute('aria-labelledby');
    if (by) return clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      const own = element.labels?.[0];
      if (own) return clean(own.textContent);
      if ('placeholder' in element && clean(element.placeholder) !== '') return clean(element.placeholder);
      if (element instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(element.type)) return clean(element.value);
      return clean(element.getAttribute('name'));
    }
    const text = clean(element.textContent);
    if (text !== '') return text;
    return clean(element.getAttribute('title') ?? element.querySelector('img')?.getAttribute('alt'));
  };

  const roleOf = (element: globalThis.Element): string => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'form') return 'form';
    if (tag === 'input') {
      const type = (element as HTMLInputElement).type;
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      return 'textbox';
    }
    return '';
  };

  const xpathOf = (element: globalThis.Element): string => {
    const parts: string[] = [];
    for (let node: globalThis.Element | null = element; node !== null && node.nodeType === 1; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const same = node.parentElement === null ? [] : [...node.parentElement.children].filter((child) => child.tagName === node?.tagName);
      parts.unshift(same.length > 1 ? `${tag}[${same.indexOf(node) + 1}]` : tag);
    }
    return `/${parts.join('/')}`;
  };

  // A control under an overlay (a modal that can't be dismissed) can't be clicked, by a person or by the explorer.
  const covered = (element: globalThis.Element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (box.width === 0 || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false; // off screen: scrolling shows it
    const hit = document.elementFromPoint(x, y);
    return hit !== null && hit !== element && !element.contains(hit) && !hit.contains(element);
  };
  const SEMANTIC = 'a[href], button, summary, input, select, textarea, [role]';
  const NAMED_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'textbox', 'combobox', 'searchbox', 'spinbutton', 'slider']);
  // Controls without a role that are still clickable (a <span onClick> tab, an <a> without href): the outermost
  // element with a pointer cursor, or a focusable one (a <label tabindex=0 onClick> copy link), not inside a real
  // control and not wrapping a form field.
  const pointer = (element: globalThis.Element) => getComputedStyle(element).cursor === 'pointer';
  const focusable = (element: globalThis.Element) => (element as HTMLElement).tabIndex >= 0 && element.hasAttribute('tabindex');
  const implicit = (element: globalThis.Element) =>
    (focusable(element) || (pointer(element) && !(element.parentElement !== null && pointer(element.parentElement)))) &&
    element.closest(SEMANTIC) === null &&
    element.querySelector(`${SEMANTIC}, input, select, textarea`) === null &&
    clean(element.textContent).length <= 60 &&
    visible(element);

  // Elements of a role, by accessible name, for the uniqueness of a role selector.
  let byRole: Map<string, number> | undefined;
  const sameRole = (key: string) => {
    if (byRole === undefined) {
      byRole = new Map();
      for (const element of [...document.querySelectorAll(SEMANTIC)].filter(visible)) {
        const own = `${roleOf(element)} ${labelOf(element)}`;
        byRole.set(own, (byRole.get(own) ?? 0) + 1);
      }
    }
    return byRole.get(key) ?? 0;
  };

  const selectorOf = (element: globalThis.Element): { selector: string; stable: boolean } => {
    const testid = element.getAttribute('data-testid');
    if (testid && count(`[data-testid="${CSS.escape(testid)}"]`) === 1) return { selector: `testid:${testid}`, stable: true };
    for (const attribute of ['data-test-id', 'data-test', 'data-cy', 'data-qa']) {
      const value = element.getAttribute(attribute);
      if (value && count(`[${attribute}="${CSS.escape(value)}"]`) === 1) return { selector: `attr:${attribute}=${value}`, stable: true };
    }
    // Generated ids (React's ":r1:", long numbers) change from build to build, so they don't count.
    const id = element.id;
    if (id && !/^[:«]|\d{4,}/.test(id) && count(`#${CSS.escape(id)}`) === 1) return { selector: `id:${id}`, stable: true };
    const name = element.getAttribute('name');
    if (name && count(`${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`) === 1) return { selector: `name:${name}`, stable: true };
    const role = roleOf(element);
    const label = labelOf(element);
    // Only roles named by their content or their label: a form or a landmark is named by aria-label alone, so its text
    // would make a selector nothing can resolve.
    if (NAMED_ROLES.has(role) && label !== '' && sameRole(`${role} ${label}`) === 1) return { selector: `role:${role} "${label}"`, stable: true };
    return { selector: `xpath:${xpathOf(element)}`, stable: false };
  };

  // The named fields of a form, in order.
  const fieldNames = (form: HTMLFormElement) =>
    [...form.elements].flatMap((element) => {
      const field = element as HTMLInputElement;
      return field.name && !['submit', 'button', 'reset', 'image', 'hidden'].includes(field.type) ? [field.name] : [];
    });

  return { clean, visible, labelOf, roleOf, xpathOf, covered, implicit, selectorOf, fieldNames, SEMANTIC };
}

export type Kit = ReturnType<typeof kit>;

// A function of (kit, argument) as a script the page can run: the kit's source goes with it.
export const inPage = (fn: (k: Kit, argument: never) => unknown, argument: unknown): string => `(${fn.toString()})((${kit.toString()})(), ${JSON.stringify(argument)})`;

export function snapshot(k: Kit, maxText: number): Snapshot {
  const { clean, visible, labelOf, roleOf, xpathOf, covered, implicit, selectorOf, SEMANTIC } = k;
  const described = (element: globalThis.Element) => ({ text: labelOf(element), ...selectorOf(element) });
  const candidates = [...document.querySelectorAll(SEMANTIC)].filter(visible);

  const forms = [...document.querySelectorAll('form')].filter((form) => (visible(form) || [...form.elements].some(visible)) && ![...form.elements].filter(visible).every(covered));
  const fieldOf = (element: globalThis.Element): Field | undefined => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return undefined;
    const type = element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase();
    if (['submit', 'button', 'reset', 'image'].includes(type)) return undefined;
    return {
      name: element.name,
      type,
      label: labelOf(element),
      required: element.required,
      visible: visible(element),
      selector: selectorOf(element).selector,
      options: element instanceof HTMLSelectElement ? [...element.options].map((option) => option.value) : [],
    };
  };

  return {
    url: location.href,
    title: document.title,
    text: clean(document.body?.innerText).slice(0, maxText),
    links: [...document.querySelectorAll('a[href]')].filter(visible).map((link) => ({ ...described(link), href: (link as HTMLAnchorElement).href })),
    buttons: [...candidates.filter((element) => ['button', 'tab', 'menuitem'].includes(roleOf(element)) && !(element as HTMLButtonElement).disabled), ...[...document.querySelectorAll('body *')].filter(implicit)]
      .filter((element) => !covered(element))
      .map((element) => {
        const form = element.closest('form');
        return { ...described(element), role: roleOf(element) || 'button', form: form === null ? null : forms.indexOf(form), group: xpathOf(element).replace(/\[\d+\]/g, ''), list: xpathOf(element).replace(/\/(tr|td|th|li)\[\d+\]/g, '/$1') };
      }),
    forms: forms.map((form) => {
      const submit = form.querySelector('button[type=submit], button:not([type]), input[type=submit]');
      return {
        ...described(form),
        method: (form.getAttribute('method') ?? 'get').toUpperCase(),
        action: form.action,
        fields: [...form.elements].flatMap((element) => fieldOf(element) ?? []),
        submit: submit === null ? null : described(submit),
      };
    }),
    password: [...document.querySelectorAll('input[type=password]')].some(visible),
  };
}
