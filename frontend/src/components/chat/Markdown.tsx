import { Fragment, type ReactNode } from 'react';

/**
 * Small Markdown renderer for assistant answers: headings, paragraphs, bullet and numbered lists, tables,
 * **bold**, *italic*, `code` and [S1] citations. It builds React elements (no HTML injection), so model output
 * is always rendered as text.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[S\d+\](?:\[S\d+\])*)/g;

export function Inline({ text }: { text: string }) {
  const parts = text.split(INLINE).filter((p) => p !== '');
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <b key={i}>{p.slice(2, -2)}</b>;
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
        if (/^\[S\d+\]/.test(p))
          return (
            <span key={i} className="cite" title="Source block — see Sources below">
              {p.replace(/\]\[/g, ', ').replace(/[[\]]/g, '')}
            </span>
          );
        if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <i key={i}>{p.slice(1, -1)}</i>;
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

export function Markdown({ text }: { text: string }) {
  const lines = (text || '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      i++;
      continue;
    }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(level <= 2 ? <h3 key={key++} className="md-h2"><Inline text={h[2]} /></h3> : <h4 key={key++} className="md-h3"><Inline text={h[2]} /></h4>);
      i++;
      continue;
    }
    if (t.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        if (!/^\|?\s*:?-{2,}/.test(lines[i].trim().replace(/^\|\s*/, ''))) rows.push(cells(lines[i]));
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        <div key={key++} className="md-table-wrap">
          <table className="table table-compact md-table">
            {head && (
              <thead>
                <tr>{head.map((c, j) => <th key={j}><Inline text={c} /></th>)}</tr>
              </thead>
            )}
            <tbody>
              {body.map((r, k) => (
                <tr key={k}>{r.map((c, j) => <td key={j}><Inline text={c} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\d+\.\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) items.push(lines[i++].trim().replace(/^\d+\.\s+/, ''));
      out.push(<ol key={key++} className="md-list">{items.map((x, j) => <li key={j}><Inline text={x} /></li>)}</ol>);
      continue;
    }
    if (/^[-*•]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) items.push(lines[i++].trim().replace(/^[-*•]\s+/, ''));
      out.push(<ul key={key++} className="md-list">{items.map((x, j) => <li key={j}><Inline text={x} /></li>)}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||\d+\.\s|[-*•]\s)/.test(lines[i].trim())) para.push(lines[i++].trim());
    out.push(<p key={key++}><Inline text={para.join(' ')} /></p>);
  }
  return <div className="md">{out}</div>;
}
