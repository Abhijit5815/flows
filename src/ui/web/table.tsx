import { useEffect, useMemo, useState } from 'react';
import type { Category } from '../../model/category.ts';
import { ChangeBadge } from './changes.tsx';
import { QaBadge } from './qa.tsx';
import { whereOf, type Item } from './model.ts';

const PAGE = 50;
type Key = 'name' | 'kind' | 'category' | 'status' | 'change' | 'qa' | 'confidence';
const COLUMNS: [Key, string][] = [['name', 'Flow'], ['kind', 'Kind'], ['category', 'Category'], ['status', 'Status'], ['change', 'Change'], ['qa', 'AI check'], ['confidence', 'Conf.']];

// The same flows as the canvas, as a table that stays quick and readable at a thousand flows: search, sort by any
// column, and pages. The filters and bulk actions above it apply to what it lists.
export function FlowTable({ items, categories, selected, onSelect }: { items: Item[]; categories: Category[]; selected: string | undefined; onSelect: (key: string) => void }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: Key; down: boolean }>({ key: 'name', down: false });
  const [page, setPage] = useState(0);
  const names = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories]);
  const rows = useMemo(() => {
    const text = query.trim().toLowerCase();
    const found = text === '' ? items : items.filter((item) => `${item.flow.name} ${whereOf(item.flow) ?? ''} ${item.flow.id}`.toLowerCase().includes(text));
    const value = (item: Item): string | number => {
      switch (sort.key) {
        case 'name': return item.flow.name.toLowerCase();
        case 'category': return names.get(item.flow.category) ?? item.flow.category;
        case 'change': return item.change === undefined ? 2 : item.change === 'new' ? 0 : 1;
        case 'qa': return item.qa === undefined ? 3 : ['ready', 'needs-work', 'not-testable'].indexOf(item.qa.verdict);
        case 'confidence': return item.flow.confidence;
        default: return item.flow[sort.key];
      }
    };
    return [...found].sort((a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * (sort.down ? -1 : 1));
  }, [items, query, sort, names]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  useEffect(() => setPage(0), [query, sort, items.length]);
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);
  const header = (key: Key, label: string) => (
    <th key={key} scope="col" aria-sort={sort.key === key ? (sort.down ? 'descending' : 'ascending') : 'none'} onClick={() => setSort({ key, down: sort.key === key && !sort.down })}>
      {label}
      {sort.key === key ? (sort.down ? ' ↓' : ' ↑') : ''}
    </th>
  );
  return (
    <div className="table-wrap">
      <div className="table-tools">
        <input type="search" aria-label="Search flows" placeholder="Search name, page, route or id" value={query} onChange={(event) => setQuery(event.target.value)} />
        <span className="muted">
          {rows.length} flows{rows.length > PAGE ? `, ${page * PAGE + 1}–${Math.min(rows.length, (page + 1) * PAGE)}` : ''}
        </span>
        {pages > 1 ? (
          <span className="button-row tight">
            <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span className="muted">
              page {page + 1} of {pages}
            </span>
            <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </span>
        ) : null}
      </div>
      <table className="flows">
        <thead>
          <tr>{COLUMNS.map(([key, label]) => header(key, label))}</tr>
        </thead>
        <tbody>
          {shown.map((item) => (
            <tr key={item.key} className={`row${item.key === selected ? ' is-selected' : ''}${item.flow.enabled ? '' : ' is-off'}`} onClick={() => onSelect(item.key)}>
              <td>
                <div>{item.flow.name}</div>
                <div className="where">{whereOf(item.flow) ?? item.flow.id}</div>
              </td>
              <td>{item.flow.kind.toUpperCase()}</td>
              <td>{names.get(item.flow.category) ?? item.flow.category}</td>
              <td>
                <span className={`pill status-${item.flow.status}`}>{item.flow.status}</span>
                {item.flow.enabled ? '' : ' off'}
              </td>
              <td>
                <ChangeBadge item={item} />
              </td>
              <td>{item.qa === undefined ? <span className="muted">—</span> : <QaBadge qa={item.qa} />}</td>
              <td>{item.flow.confidence.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="page-message">No flow matches.</p> : null}
    </div>
  );
}
