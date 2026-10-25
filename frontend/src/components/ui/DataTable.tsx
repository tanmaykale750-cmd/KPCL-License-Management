import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sort?: (row: T) => number | string;
  num?: boolean;
  width?: number | string;
  title?: string;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  selectedKey,
  rowClass,
  initialSort,
  empty,
  footer,
  ledger,
  compact,
  pageSize,
  caption,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  rowClass?: (row: T) => string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  empty?: ReactNode;
  footer?: ReactNode;
  ledger?: boolean;
  compact?: boolean;
  pageSize?: number;
  caption?: string;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const s = [...rows].sort((a, b) => {
      const va = col.sort!(a);
      const vb = col.sort!(b);
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      return String(va).localeCompare(String(vb));
    });
    return sort.dir === 'desc' ? s.reverse() : s;
  }, [rows, columns, sort]);

  const pages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(page, pages - 1);
  const visible = pageSize ? sorted.slice(current * pageSize, current * pageSize + pageSize) : sorted;

  const toggle = (key: string) => {
    setPage(0);
    setSort((s) => (s?.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: 'desc' }));
  };

  return (
    <div className="table-wrap">
      <table className={`table${ledger ? ' ledger' : ''}${compact ? ' table-compact' : ''}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  className={c.num ? 'num' : undefined}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  title={c.title}
                >
                  {c.sort ? (
                    <button onClick={() => toggle(c.key)}>
                      {c.header}
                      {active ? sort!.dir === 'asc' ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden /> : <ArrowUpDown aria-hidden style={{ opacity: 0.4 }} />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={columns.length}>{empty ?? <div className="empty">No records match the current filters.</div>}</td>
            </tr>
          )}
          {visible.map((r) => {
            const k = rowKey(r);
            const cls = [onRowClick ? 'clickable' : '', selectedKey === k ? 'selected' : '', rowClass?.(r) ?? ''].join(' ').trim();
            return (
              <tr
                key={k}
                className={cls || undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter') onRowClick(r);
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : undefined}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
      {pageSize && pages > 1 && (
        <div className="row-between" style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-2)' }}>
          <span>
            {current * pageSize + 1}–{Math.min(sorted.length, (current + 1) * pageSize)} of {sorted.length}
          </span>
          <span className="row">
            <button className="btn sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
              Previous
            </button>
            <button className="btn sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              Next
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
