import { useState } from 'react';
import { FALLBACK_CATEGORY_ID, type Category } from '../../model/category.ts';
import type { ProjectView } from '../api.ts';
import { Problem, useSend, type OnView } from './actions.tsx';

// PLAN.md Phase 5 category editor: create, rename, recolour, switch off, and merge one category into another.
export function CategoryEditor({ project, onView, onClose }: { project: ProjectView; onView: OnView; onClose: () => void }) {
  const { busy, error, send } = useSend(onView);
  const [list, setList] = useState<Category[]>(project.categories);
  const [merges, setMerges] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ id: '', name: '', color: '#3366cc' });
  const update = (id: string, change: Partial<Category>) => setList(list.map((category) => (category.id === id ? { ...category, ...change } : category)));
  const addable = /^[a-z][a-z0-9-]*$/.test(draft.id) && draft.name.trim() !== '' && !list.some((category) => category.id === draft.id);
  const save = () => {
    const kept = list.filter((category) => merges[category.id] === undefined);
    return send('/api/categories', { categories: kept, merges: Object.entries(merges).map(([from, to]) => ({ from, to })) }).then((ok) => ok && setMerges({}));
  };
  return (
    <aside className="panel" aria-label="Categories">
      <header className="panel-head">
        <h2>Categories</h2>
        <button type="button" className="icon" onClick={onClose} aria-label="Close the category editor">
          ×
        </button>
      </header>
      <p className="muted">Switching a category off leaves its flows out of the export. Merging moves its flows into another category, then removes it.</p>
      <ul className="category-list">
        {list.map((category) => {
          const fixed = category.id === FALLBACK_CATEGORY_ID;
          return (
            <li key={category.id} className={merges[category.id] === undefined ? undefined : 'is-off'}>
              <input type="color" aria-label={`Colour of ${category.name}`} value={category.color} disabled={fixed} onChange={(event) => update(category.id, { color: event.target.value })} />
              <input aria-label={`Name of ${category.id}`} value={category.name} disabled={fixed} onChange={(event) => update(category.id, { name: event.target.value })} />
              <label className="inline" htmlFor={`category-on-${category.id}`}>
                <input id={`category-on-${category.id}`} type="checkbox" checked={category.enabled} onChange={(event) => update(category.id, { enabled: event.target.checked })} />
                On
              </label>
              {fixed ? (
                <span className="muted">fallback</span>
              ) : (
                <select aria-label={`Merge ${category.name} into`} value={merges[category.id] ?? ''} onChange={(event) => {
                    const { [category.id]: _, ...rest } = merges;
                    setMerges(event.target.value === '' ? rest : { ...rest, [category.id]: event.target.value });
                  }}>
                  <option value="">Keep</option>
                  {list
                    .filter((other) => other.id !== category.id && merges[other.id] === undefined)
                    .map((other) => (
                      <option key={other.id} value={other.id}>
                        Merge into {other.name}
                      </option>
                    ))}
                </select>
              )}
            </li>
          );
        })}
      </ul>
      <h3>New category</h3>
      <div className="button-row">
        <input aria-label="New category id (lower-case words and hyphens)" placeholder="checkout" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
        <input aria-label="New category name" placeholder="Checkout & payment" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <input type="color" aria-label="New category colour" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} />
        <button
          type="button"
          disabled={!addable}
          onClick={() => {
            setList([...list.filter((category) => category.id !== FALLBACK_CATEGORY_ID), { id: draft.id, name: draft.name.trim(), color: draft.color, editable: true, enabled: true }, ...list.filter((category) => category.id === FALLBACK_CATEGORY_ID)]);
            setDraft({ id: '', name: '', color: '#3366cc' });
          }}
        >
          Add
        </button>
      </div>
      <div className="button-row">
        <button type="button" disabled={busy} onClick={save}>
          Save categories
        </button>
        <button type="button" disabled={busy} onClick={() => (setList(project.categories), setMerges({}))}>
          Undo
        </button>
      </div>
      <Problem error={error} />
    </aside>
  );
}
