import { ArrowRight, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Inline, Markdown } from './Markdown';

/** The assistant's structured answer (rag_chatbot/respond.py `Structured`). */
export interface StructuredSection {
  id: string;
  title: string;
  kind: 'text' | 'bullets' | 'steps' | 'table';
  text: string;
  items: string[];
  columns: string[];
  rows: string[][];
  note: string;
}

export interface Structured {
  question_type: string;
  title: string;
  summary: string;
  highlights: { label: string; value: string; tone: 'ok' | 'warn' | 'crit' | 'info' }[];
  sections: StructuredSection[];
  next_steps: { text: string; owner?: string }[];
  caveats: string[];
  follow_ups: string[];
  sources: { label: string; title: string }[];
  viewer: { role: string; label: string };
  pool: [string, string] | null;
}

export const QTYPE_LABEL: Record<string, string> = {
  drivers: 'Why · drivers',
  forecast: 'Forecast',
  availability: 'Availability for you',
  recommendation: 'Recommendation',
  rec_why: 'Why this recommendation',
  options: 'Options & costs',
  next_steps: 'Next steps',
  whatif: 'What-if',
  whatif_blocked: 'What-if not permitted',
  renewal: 'Renewal',
  overview: 'Pool overview',
  ranking: 'Ranking',
  portfolio: 'Portfolio',
  software: 'Software',
  renewal_all: 'Renewals',
  accuracy: 'Model accuracy',
  method: 'How it works',
  glossary: 'Definition',
  assumption: 'Assumptions',
  unknown: 'Clarify',
};

function Section({ s }: { s: StructuredSection }) {
  return (
    <section className="sa-section">
      <h4>{s.title}</h4>
      {s.kind === 'table' && s.columns.length > 0 && (
        <div className="md-table-wrap">
          <table className="table table-compact md-table">
            <thead>
              <tr>{s.columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {s.rows.map((r, i) => (
                <tr key={i} className={r.some((c) => String(c).includes('at risk')) ? 'flag-warn' : ''}>
                  {r.map((c, j) => <td key={j}><Inline text={String(c)} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.kind === 'steps' && <ol className="md-list">{s.items.map((x, i) => <li key={i}><Inline text={x} /></li>)}</ol>}
      {s.kind === 'bullets' && <ul className="md-list">{s.items.map((x, i) => <li key={i}><Inline text={x} /></li>)}</ul>}
      {s.text && <p><Inline text={s.text} /></p>}
      {s.note && <p className="sa-note"><Inline text={s.note} /></p>}
    </section>
  );
}

/**
 * Renders an answer: the direct answer, key figures, the question's own sections, next steps with owners, caveats,
 * follow-up questions (clickable) and sources. With an LLM, its wording replaces the composed sections; key figures,
 * follow-ups and sources still come from the structured answer.
 */
export function StructuredAnswer({ st, llmText, onAsk }: { st: Structured; llmText?: string | null; onAsk: (q: string) => void }) {
  const [showSources, setShowSources] = useState(false);
  return (
    <div className="sa">
      <div className="sa-title">{st.title}</div>
      {llmText ? (
        <>
          {st.highlights.length > 0 && <Highlights st={st} />}
          <Markdown text={llmText} />
        </>
      ) : (
        <>
          <p className="sa-summary">
            <Inline text={st.summary} />
          </p>
          {st.highlights.length > 0 && <Highlights st={st} />}
          {st.sections.map((s) => (
            <Section key={s.id + s.title} s={s} />
          ))}
          {st.next_steps.length > 0 && (
            <section className="sa-section sa-next">
              <h4>Next steps</h4>
              <ol className="md-list">
                {st.next_steps.map((n, i) => (
                  <li key={i}>
                    <Inline text={n.text} />
                    {n.owner && <span className="sa-owner">{n.owner}</span>}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {st.caveats.length > 0 && (
            <section className="sa-section sa-caveats">
              <h4>Risks and caveats</h4>
              <ul className="md-list">{st.caveats.map((c, i) => <li key={i}><Inline text={c} /></li>)}</ul>
            </section>
          )}
        </>
      )}
      {st.follow_ups.length > 0 && (
        <div className="sa-follow">
          <span className="label-caps">Ask next</span>
          {st.follow_ups.map((q) => (
            <button key={q} className="sa-chip" onClick={() => onAsk(q)}>
              {q} <ArrowRight aria-hidden />
            </button>
          ))}
        </div>
      )}
      {st.sources.length > 0 && (
        <div className="sa-sources">
          <button className="link-btn small" aria-expanded={showSources} onClick={() => setShowSources((v) => !v)}>
            <ChevronDown aria-hidden style={{ width: 13, height: 13, transform: showSources ? 'rotate(180deg)' : undefined }} /> Sources ({st.sources.length})
          </button>
          {showSources && (
            <ol className="sa-source-list">
              {st.sources.map((s) => (
                <li key={s.label}>
                  <span className="cite">{s.label}</span> {s.title}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function Highlights({ st }: { st: Structured }) {
  return (
    <dl className="sa-figures">
      {st.highlights.map((h) => (
        <div key={h.label} className={`tone-${h.tone}`}>
          <dt>{h.label}</dt>
          <dd>{h.value}</dd>
        </div>
      ))}
    </dl>
  );
}
