import { kit, type Kit } from './snapshot.ts';

// What the overlay reports about an element, found and named with the explorer's own kit (snapshot.ts).
export type Facts = { path: string; tag: string; text: string; role: string; selector: string; stable: boolean; href: string | null; fields: string[]; inForm: boolean };

// steps: a guided walk's steps (null in free mode); token: this run's secret, so only the overlay's calls count.
export type OverlayConfig = { steps: { id: string; claim: string }[] | null; token: string };

// The inspector's overlay (PLAN.md Phase 3), as a script for every page of the inspector's browser: the kit's source
// goes with it, because the page can't import anything.
export const overlayScript = (config: OverlayConfig): string => `(${overlay.toString()})(${kit.toString()}, ${JSON.stringify(config)})`;

// Runs in the page. It draws inside its own shadow root, so the app's styles can't reach it, and reports what the
// person does: what they point at (Flows answers with what source knows), what they click and submit, a correction,
// and Done. A fresh kit per event, because the page changes under it.
export function overlay(makeKit: () => Kit, config: OverlayConfig): void {
  if (window.top !== window) return;
  type Bridge = (event: Record<string, unknown>) => Promise<unknown>;
  const call = (event: Record<string, unknown>): Promise<unknown> => {
    const bridge = (window as unknown as { __flows?: Bridge }).__flows;
    return bridge === undefined ? Promise.resolve(undefined) : bridge({ ...event, token: config.token }).catch(() => undefined);
  };
  type Known = { pattern: string; node: { id: string; label: string; ref: string } | null; corrected: boolean; flows: string[]; candidates: { id: string; label: string }[] };

  const start = () => {
    if (document.querySelector('flows-inspector') !== null) return;
    const host = document.createElement('flows-inspector');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      * { box-sizing: border-box; font: 12px/1.4 system-ui, sans-serif; }
      .panel, .tip { position: fixed; pointer-events: auto; background: #16181d; color: #eceef2; border: 1px solid #3a3f4b; border-radius: 8px; padding: 8px 10px; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
      .panel { right: 12px; bottom: 12px; width: 300px; }
      .tip { max-width: 340px; }
      h1 { font-weight: 600; margin: 0 0 4px; }
      p { margin: 2px 0; }
      .muted { color: #9aa1ad; }
      ol { margin: 6px 0; padding-left: 18px; }
      li.done { color: #4cc38a; }
      li.done::marker { content: '✓ '; }
      button, select { pointer-events: auto; background: #262a33; color: inherit; border: 1px solid #3a3f4b; border-radius: 6px; padding: 2px 8px; }
      .outline { position: fixed; border: 2px solid #7ea6ff; border-radius: 4px; pointer-events: none; }
      [hidden] { display: none !important; }
    </style>
    <div class="outline" hidden></div>
    <div class="tip" hidden><p class="what"></p><p class="flows muted"></p><p class="fix"><label>It is <select class="pick"></select></label> <button class="save" type="button">Correct it</button></p></div>
    <div class="panel"><h1>Flows inspector</h1><p class="mode muted"></p><ol class="steps"></ol><button class="done" type="button">Done</button></div>`;
    document.documentElement.appendChild(host);
    const $ = <T extends globalThis.Element>(selector: string) => root.querySelector(selector) as T;
    $('.mode').textContent = config.steps === null ? 'Recording what you do. Point at anything to see what source knows about it.' : 'Do these steps; each is ticked when what you do matches it.';
    for (const step of config.steps ?? []) {
      const item = document.createElement('li');
      item.dataset.step = step.id;
      item.textContent = step.claim;
      $('.steps').appendChild(item);
    }

    const controlOf = (target: EventTarget | null): globalThis.Element | null => {
      const k = makeKit();
      for (let element = target instanceof globalThis.Element ? target : null; element !== null && element !== document.body; element = element.parentElement) {
        if (element === host) return null;
        if (element.matches(k.SEMANTIC) || k.implicit(element) || element instanceof HTMLFormElement) return element;
      }
      return null;
    };
    const factsOf = (element: globalThis.Element): Facts => {
      const k = makeKit();
      const form = element instanceof HTMLFormElement ? element : element.closest('form');
      const { selector, stable } = k.selectorOf(element);
      return {
        path: location.pathname,
        tag: element.tagName.toLowerCase(),
        text: k.labelOf(element),
        role: k.roleOf(element) || 'button',
        selector,
        stable,
        href: element instanceof HTMLAnchorElement ? element.href : null,
        fields: form === null ? [] : k.fieldNames(form),
        inForm: form !== null,
      };
    };

    let current: globalThis.Element | null = null;
    const show = (known: Known | undefined) => {
      if (known === undefined || current === null) return;
      const box = current.getBoundingClientRect();
      const outline = $<HTMLElement>('.outline');
      Object.assign(outline.style, { left: `${box.left - 2}px`, top: `${box.top - 2}px`, width: `${box.width + 4}px`, height: `${box.height + 4}px` });
      outline.hidden = false;
      $('.what').textContent = known.node === null ? `Not in source (on ${known.pattern})` : `In source: ${known.node.label} · ${known.node.ref}${known.corrected ? ' (as a person corrected it)' : ''}`;
      $('.flows').textContent = known.flows.length === 0 ? '' : `Used by: ${known.flows.join(', ')}`;
      const pick = $<HTMLSelectElement>('.pick');
      pick.replaceChildren(...[{ id: '', label: 'none of these' }, ...known.candidates].map((candidate) => Object.assign(document.createElement('option'), { value: candidate.id, textContent: candidate.label, selected: candidate.id === (known.node?.id ?? '') })));
      const tip = $<HTMLElement>('.tip');
      Object.assign(tip.style, { left: `${Math.min(box.left, innerWidth - 350)}px`, top: `${box.bottom + 8 > innerHeight - 120 ? Math.max(box.top - 110, 8) : box.bottom + 8}px` });
      tip.hidden = false;
    };

    let last = 0;
    document.addEventListener(
      'mouseover',
      (event) => {
        const control = controlOf(event.target);
        if (control === null || control === current || Date.now() - last < 120) return;
        last = Date.now();
        current = control;
        void call({ type: 'hover', facts: factsOf(control) }).then((known) => show(known as Known | undefined));
      },
      true,
    );
    document.addEventListener(
      'click',
      (event) => {
        const control = controlOf(event.target);
        // A form's submit button is reported by its submit event.
        if (control === null || control instanceof HTMLFormElement || (control.closest('form') !== null && control.matches('button:not([type]), button[type=submit], input[type=submit]'))) return;
        void call({ type: 'click', facts: factsOf(control) });
      },
      true,
    );
    document.addEventListener('submit', (event) => void call({ type: 'submit', facts: factsOf(event.target as HTMLFormElement) }), true);
    $('.save').addEventListener('click', () => {
      if (current === null) return;
      const node = $<HTMLSelectElement>('.pick').value;
      void call({ type: 'correct', facts: factsOf(current), node: node === '' ? null : node }).then((known) => show(known as Known | undefined));
    });
    $('.done').addEventListener('click', () => void call({ type: 'done' }));
    const tick = () =>
      void call({ type: 'ticks' }).then((ticked) => {
        for (const item of root.querySelectorAll<HTMLElement>('li[data-step]')) item.classList.toggle('done', Array.isArray(ticked) && ticked.includes(item.dataset.step));
      });
    setInterval(tick, 800);
    tick();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
