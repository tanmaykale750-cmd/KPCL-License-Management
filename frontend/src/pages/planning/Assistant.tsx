import { ArrowRight, Bot, CornerDownLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { forecast, runs, shortageSummary } from '../../calc/forecast';
import { DEFAULT_FILTERS, nextRenewals, rarelyUsed } from '../../calc/metrics';
import { evaluatePlan, emptyPlan, renewalAdvice } from '../../calc/plan';
import { ledgerTotals } from '../../calc/review';
import type { Dataset } from '../../data/dataset';
import type { Licence } from '../../domain/types';
import { fmtDate } from '../../lib/dates';
import { hours, inrShort } from '../../lib/format';
import { nextStep, stepName } from '../../state/workflow';
import { useApp } from '../../state/store';
import { api } from '../../api/client';
import { useSessionOptional } from '../../api/session';
import { QTYPE_LABEL, StructuredAnswer, type Structured } from '../../components/chat/StructuredAnswer';
import { Markdown } from '../../components/chat/Markdown';

/**
 * Rule-based planning assistant. It recognises a fixed set of question patterns and answers
 * them from the same calculations the screens use. There is no language model behind it.
 */

interface Answer {
  intent: string;
  lines: string[];
  facts?: { label: string; value: string }[];
  links?: { label: string; to: string }[];
  source: string;
}

interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
  meta: { entities?: unknown; qtype?: string };
}

interface ChatReply {
  answer: string;
  llm_used: string | null;
  notes: string[];
  suggestions: string[];
  intents: string[];
  question_type: string;
  structured: Structured | null;
  entities: unknown;
  focus: [string, string] | null;
  sources: { label: string; title: string; source: string; kind: string }[];
}

/** A turn is answered by the RAG assistant (API) or, when the API is unreachable, by the local rule-based helper. */
type Turn = { q: string; pending?: boolean; rag?: ChatReply; local?: Answer };

/** Starter questions per profile (pools are portfolio × software from the ML dataset). */
const ROLE_STARTERS: Record<string, string[]> = {
  admin: ['Why is PF001 ANSYS at risk?', 'What should we do about PF001 ANSYS?', 'What options do we have for PF001 ANSYS and what do they cost?', 'Which pools are candidates for reduction at renewal?', 'How accurate is the forecast model?'],
  deptHead: ['Why is PF001 ANSYS at risk?', 'What are the next steps for PF001 ANSYS?', 'Which pools are riskiest for ANSYS?', 'What if we add 2 temporary licences to PF001 ANSYS?'],
  projectLead: ['Why is PF001 ANSYS at risk?', 'What if we delay P1419 by 1 month in PF001 ANSYS?', 'What is the forecast for PF001 ANSYS?', 'What does P90 mean?'],
  engineer: ['Will ANSYS be available for PF001 in December?', 'Which pools are riskiest for ANSYS?', 'What does shortage chance mean?', 'How accurate is the forecast model?'],
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const ALIASES: Record<string, string> = {
  ansys: 'ANS-MECH',
  mechanical: 'ANS-MECH',
  nashik: 'ANS-MECH-NSK',
  hpc: 'ANS-HPC',
  cfd: 'ANS-CFD',
  fluent: 'ANS-CFD',
  inventor: 'INV-PRO',
  academic: 'ACAD-MECH',
  vault: 'ADSK-VAULT',
  flex: 'ADSK-FLEX',
  solidworks: 'SW-PREM',
  altair: 'ALT-HW',
  hyperworks: 'ALT-HW',
  algor: 'CAD-ALG',
};

export const SUGGESTIONS = [
  'Will we run short of ANSYS in February?',
  'What happens if Project Y moves 4 weeks later?',
  'Which licences are underused?',
  'Which renewals are due in the next 90 days?',
  'What is waiting for my approval?',
  'How much have we saved so far?',
];

function findLicence(ds: Dataset, q: string): Licence | undefined {
  const t = q.toLowerCase();
  const byId = ds.licences.find((l) => t.includes(l.id.toLowerCase()));
  if (byId) return byId;
  // most specific alias first (e.g. "ansys cfd" → CFD, not Mechanical)
  const hits = Object.entries(ALIASES).filter(([k]) => t.includes(k));
  const specific = hits.find(([k]) => k !== 'ansys' && k !== 'mechanical');
  const id = (specific ?? hits[0])?.[1];
  return id ? ds.licences.find((l) => l.id === id) : undefined;
}

function findMonth(q: string): number | null {
  const t = q.toLowerCase();
  const i = MONTHS.findIndex((m) => new RegExp(`\\b${m}`).test(t));
  return i >= 0 ? i : null;
}

function findProject(ds: Dataset, q: string) {
  const t = q.toLowerCase();
  return ds.projects.find((p) => p.status !== 'completed' && (t.includes(p.id.toLowerCase()) || t.includes(p.name.toLowerCase()) || new RegExp(`\\bproject ${p.shortName.replace(/^project /i, '').toLowerCase()}\\b`).test(t) || t.includes(p.shortName.toLowerCase())));
}

export function useAssistant() {
  const { ds, state, perms, me } = useApp();
  const role = state.role;
  const fin = state.finance[0];

  return (raw: string): Answer => {
    const q = raw.trim();
    const t = q.toLowerCase();
    const lic = findLicence(ds, q);
    const proj = findProject(ds, q);
    const weeksMatch = t.match(/(-?\d+)\s*(?:weeks?|wks?)/);
    const money = (v: number) => (perms.seesCosts ? inrShort(v) : 'hidden for your role');

    // 1 — project moves
    if (proj && weeksMatch && /(move|shift|delay|slip|later|earlier|bring forward|push)/.test(t)) {
      if (perms.runWhatIf === 'none') return { intent: 'What-if', lines: ['Your role cannot run planning scenarios.'], source: 'Role permissions' };
      if (perms.projectScope && !perms.projectScope.includes(proj.id)) return { intent: 'What-if', lines: [`You can only simulate changes to your own project (${perms.projectScope.join(', ')}).`], source: 'Role permissions' };
      let w = Number(weeksMatch[1]);
      if (/(earlier|bring forward|forward)/.test(t)) w = -Math.abs(w);
      const pools = [...new Set<string>(proj.phases.flatMap((ph) => ph.demand.map((d) => d.licenceId)))].filter((id) => ds.licences.find((l) => l.id === id)?.forecastable);
      const target = lic && pools.includes(lic.id) ? [lic.id] : pools;
      const lines: string[] = [];
      const facts: Answer['facts'] = [];
      for (const id of target) {
        const l = ds.licences.find((x) => x.id === id)!;
        const base = evaluatePlan(ds, emptyPlan(id), fin);
        const moved = evaluatePlan(ds, { ...emptyPlan(id), projectShifts: { [proj.id]: w } }, fin);
        const dW = moved.shortage.forecastShortWeeks.length - base.shortage.forecastShortWeeks.length;
        const dH = moved.blockedHours - base.blockedHours;
        lines.push(
          `${l.product}: forecast shortage weeks ${base.shortage.forecastShortWeeks.length} → ${moved.shortage.forecastShortWeeks.length} (${dW === 0 ? 'no change' : dW > 0 ? `+${dW}` : dW}); expected blocked hours ${Math.round(base.blockedHours)} → ${Math.round(moved.blockedHours)}.` +
            (moved.criticalBreaches.length ? ` A critical project is still short (${moved.criticalBreaches.map((b) => ds.projects.find((p) => p.id === b.projectId)?.shortName).join(', ')}).` : ''),
        );
        facts.push({ label: `${l.id} blocked hours`, value: `${dH >= 0 ? '+' : ''}${Math.round(dH)} h` });
        if (perms.seesCosts) facts.push({ label: `${l.id} cost of blocked time`, value: inrShort(moved.blockedCost - base.blockedCost, { sign: true }) });
      }
      lines.push('This is a simulation only. The project dates in the registry are unchanged; a date change needs the project leader, department head and administrator.');
      return {
        intent: `What-if · ${proj.shortName} ${w > 0 ? '+' : ''}${w} weeks`,
        lines,
        facts,
        links: [{ label: 'Open in what-if', to: `/planning?tab=whatif&licence=${target[0] ?? 'ANS-MECH'}&project=${proj.id}&shift=${w}` }],
        source: 'Forecast with the project phases shifted · same calculation as the What-if tab',
      };
    }

    // 2 — shortage / forecast for a pool
    if (lic && /(short|enough|run out|forecast|demand|need|capacity|seats)/.test(t)) {
      if (!perms.areas.includes('planning')) return { intent: 'Forecast', lines: ['Your role does not include the Planning Studio.'], source: 'Role permissions' };
      if (!lic.forecastable) return { intent: 'Forecast', lines: [`${lic.product} is not forecast weekly (too few concurrent-use records). Check the licence record instead.`], links: [{ label: 'Open licence', to: `/software?open=${lic.id}` }], source: 'Licence registry' };
      const f = forecast(ds, lic.id, { horizonWeeks: 26 });
      const month = findMonth(q);
      const pts = month === null ? f.points : f.points.filter((p) => new Date(p.week).getMonth() === month);
      if (!pts.length) return { intent: 'Forecast', lines: ['That month is outside the 26-week forecast horizon.'], source: 'Forecast horizon' };
      const short = pts.filter((p) => p.p90 > p.capacity);
      const peak = pts.reduce((m, p) => (p.p90 > m.p90 ? p : m), pts[0]);
      const s = shortageSummary({ ...f, points: pts });
      const window = runs(short.map((p) => p.week)).map((r) => `${fmtDate(r.start)}–${fmtDate(r.end)}`).join(', ');
      const projs = [...new Set(peak.projects.map((c) => ds.projects.find((p) => p.id === c.projectId)?.shortName))].filter(Boolean);
      const lines = short.length
        ? [
            `Yes, likely. In the high-demand case (P90) ${lic.product} needs up to ${peak.p90.toFixed(1)} ${lic.unitLabel} against ${peak.capacity} owned — ${short.length} week${short.length > 1 ? 's' : ''} short (${window}).`,
            `Expected demand (P50) peaks at ${peak.p50.toFixed(1)}. The peak comes from routine use (${peak.baseline.toFixed(1)})${projs.length ? ` plus ${projs.join(', ')}` : ''}.`,
            `Doing nothing: about ${hours(s.blockedHours)} of blocked engineering time${perms.seesCosts ? ` ≈ ${inrShort(s.blockedHours * fin.loadedHourlyCost * fin.productivityLoss)}` : ''}.`,
          ]
        : [`No. ${lic.product} stays within ${lic.seats} ${lic.unitLabel} even in the high-demand case (peak P90 ${peak.p90.toFixed(1)}${month !== null ? ` in ${MONTHS[month].replace(/^./, (c) => c.toUpperCase())}` : ''}).`];
      return {
        intent: `Forecast · ${lic.id}${month !== null ? ` · ${MONTHS[month]}` : ''}`,
        lines,
        facts: [
          { label: 'Peak P50 / P90', value: `${peak.p50.toFixed(1)} / ${peak.p90.toFixed(1)}` },
          { label: 'Owned', value: String(peak.capacity) },
          { label: 'Backtest MASE', value: `${f.backtest.mase.toFixed(2)}${f.backtest.beatsNaive ? ' (beats naive)' : ''}` },
        ],
        links: [
          { label: 'See forecast', to: `/planning?tab=forecast&licence=${lic.id}` },
          ...(short.length && perms.seesCosts ? [{ label: 'Compare options', to: `/planning?tab=optimise&licence=${lic.id}` }] : []),
        ],
        source: 'Baseline from 104 weeks of usage + project layer × calibration ratio · synthetic sample data',
      };
    }

    // 3 — underused
    if (/(underused|under-used|unused|idle|waste|rarely|reduce|cut|surplus)/.test(t)) {
      if (!perms.seesCosts && !perms.areas.includes('software')) return { intent: 'Underused licences', lines: ['Your role does not include portfolio utilisation.'], source: 'Role permissions' };
      const filters = { ...DEFAULT_FILTERS, deptId: perms.deptScope ?? 'all' };
      const rare = rarelyUsed(ds, filters).slice(0, 4);
      const advice = ds.licences.map((l) => renewalAdvice(ds, l.id)).filter((a) => a.reduceBy > 0).sort((a, b) => b.annualSaving - a.annualSaving).slice(0, 3);
      return {
        intent: 'Underused licences',
        lines: [
          ...advice.map((a) => `${a.licence.product}: keep ${a.keep} of ${a.licence.seats} at renewal ${fmtDate(a.licence.renewalDate)} — ${money(a.annualSaving)} a year. ${a.reason}`),
          ...(rare.length ? [`Rarely used: ${rare.map((r) => `${r.licence.product} (${r.reason})`).join('; ')}.`] : []),
        ],
        links: [
          { label: 'Software register', to: '/software' },
          ...(perms.areas.includes('registry') ? [{ label: 'Reduction report', to: '/registry?tab=approvals&view=report' }] : []),
        ],
        source: 'Last-active dates for named seats; 52-week P90 for floating pools',
      };
    }

    // 4 — renewals
    if (/(renew|renewal|expir|due)/.test(t)) {
      const days = Number(t.match(/(\d+)\s*days?/)?.[1] ?? 90);
      const list = nextRenewals(ds, { ...DEFAULT_FILTERS, deptId: perms.deptScope ?? 'all' }, days);
      return {
        intent: `Renewals · next ${days} days`,
        lines: list.length ? list.map((l) => { const a = renewalAdvice(ds, l.id); return `${fmtDate(l.renewalDate)} · ${l.product} (${l.seats} ${l.unitLabel}${perms.seesCosts ? `, ${inrShort(l.seats * l.costPerSeat)}` : ''}) — ${a.reduceBy > 0 ? `option to keep ${a.keep}` : 'keep quantity'}.`; }) : [`No renewals in the next ${days} days.`],
        links: [{ label: 'Renewal brief', to: '/reports' }],
        source: 'Licence registry renewal dates',
      };
    }

    // 5 — approvals
    if (/(approv|waiting|pending|sign|queue|my action|to do)/.test(t)) {
      const recs = state.recommendations.filter((r) => r.status === 'pending' && (perms.approvalSteps.includes(nextStep(r) ?? 'admin') || (perms.approvalSteps.includes('deptHead') && !r.approvals.some((a) => a.step === 'deptHead'))));
      const reqs = perms.approveRequests ? state.requests.filter((r) => r.status === 'submitted' && ds.users.find((u) => u.id === r.requesterId)?.deptId === perms.deptScope) : perms.fulfilRequests ? state.requests.filter((r) => r.status === 'approved') : [];
      const lines = [
        ...recs.map((r) => `${r.id} · ${r.title} — waiting for ${stepName(nextStep(r) ?? 'admin')}${r.submittedBy === me.name ? ' (you submitted it, so someone else must approve)' : ''}.`),
        ...reqs.map((r) => `${r.id} · access request for ${ds.licences.find((l) => l.id === r.licenceId)?.product} — ${r.status === 'approved' ? 'approved, to fulfil' : 'to review'}.`),
      ];
      return {
        intent: 'Your queue',
        lines: lines.length ? lines : ['Nothing is waiting for you.'],
        links: [...(recs.length && perms.areas.includes('registry') ? [{ label: 'Approvals', to: '/registry?tab=approvals' }] : []), ...(reqs.length ? [{ label: 'Access requests', to: '/access-requests' }] : [])],
        source: `Workflow state for ${role}`,
      };
    }

    // 6 — savings
    if (/(sav|saved|realis|verified|outcome)/.test(t)) {
      if (!perms.seesCosts) return { intent: 'Savings', lines: ['Savings figures are not shown for your role.'], source: 'Role permissions' };
      const potential = ds.licences.map((l) => renewalAdvice(ds, l.id)).reduce((a, x) => a + x.annualSaving, 0);
      const tot = ledgerTotals(state.review, potential);
      return {
        intent: 'Savings',
        lines: [
          `Verified against invoices: ${inrShort(tot.verified)}. Approved: ${inrShort(tot.approved)}; realised but not yet verified on an invoice counts as estimated (${inrShort(tot.realised - tot.verified)}).`,
          `Further potential identified at renewals: ${inrShort(tot.potential)} — not a saving until approved and invoiced.`,
        ],
        facts: [
          { label: 'Potential', value: inrShort(tot.potential) },
          { label: 'Approved', value: inrShort(tot.approved) },
          { label: 'Realised', value: inrShort(tot.realised) },
          { label: 'Verified', value: inrShort(tot.verified) },
        ],
        links: [{ label: 'Review & Savings', to: '/review' }],
        source: 'Outcome register and invoice lines',
      };
    }

    // 7 — "why" about a licence without other cues
    if (lic) {
      return {
        intent: `Licence · ${lic.id}`,
        lines: [`${lic.product}: ${lic.seats} ${lic.unitLabel}, ${lic.type}, renews ${fmtDate(lic.renewalDate)}${perms.seesCosts ? `, ${inrShort(lic.seats * lic.costPerSeat)} a year` : ''}. Ask “will we run short of ${lic.product.split(' ')[0]} in March?” for a forecast.`],
        links: [{ label: 'Open licence', to: `/software?open=${lic.id}` }],
        source: 'Licence registry',
      };
    }

    return {
      intent: 'Not recognised',
      lines: ['I answer a fixed set of planning questions from the sample data. Try one of these:', ...SUGGESTIONS.map((s) => `“${s}”`)],
      source: 'Rule-based intent matching — no language model',
    };
  };
}

export function Assistant({ dark = false, initialQuestion }: { dark?: boolean; initialQuestion?: string | null }) {
  const ask = useAssistant();
  const role = useApp().state.role;
  const session = useSessionOptional();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const suggestions = useMemo(() => ROLE_STARTERS[role] ?? ROLE_STARTERS.admin, [role]);

  const history = useRef<ChatHistoryItem[]>([]);
  const focus = useRef<[string, string] | null>(null);
  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setQ('');
    setBusy(true);
    setTurns((t) => [...t, { q: text, pending: true }]);
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }));
    let turn: Turn;
    try {
      // RAG assistant: retrieval + live ensemble forecast, simulation and recommendation engine, answered for this question
      const r = await api.post<ChatReply>('/chat', { question: text, history: history.current, focus: focus.current });
      const next: ChatHistoryItem[] = [
        ...history.current,
        { role: 'user', content: text, meta: {} },
        { role: 'assistant', content: r.answer, meta: { entities: r.entities, qtype: r.question_type } },
      ];
      history.current = next.slice(-12);
      if (r.focus) focus.current = r.focus;
      turn = { q: text, rag: r };
    } catch (e) {
      // Keep the original rule-based assistant working when the API is unavailable
      const local = ask(text);
      turn = { q: text, local: { ...local, source: `${local.source} (RAG assistant unavailable: ${e instanceof Error ? e.message : 'error'})` } };
    }
    setTurns((t) => [...t.slice(0, -1), turn]);
    setBusy(false);
    // show the new answer from its first line (answers are long; the summary comes first)
    requestAnimationFrame(() => {
      const all = logRef.current?.querySelectorAll('.assistant-turn');
      all?.[all.length - 1]?.scrollIntoView({ block: 'start' });
    });
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(q);
  };
  const started = useRef(false);
  useEffect(() => {
    if (initialQuestion && !started.current) {
      started.current = true;
      send(initialQuestion);
    }
  }, [initialQuestion]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`assistant${dark ? ' dark' : ''}`}>
      <div className="assistant-disclosure">
        <Bot aria-hidden />
        <span>
          RAG assistant: answers each question from live runs of the ensemble forecast, the Monte Carlo simulation and the recommendation engine, with sources. Answers are tailored to your profile
          {session ? ` (${session.profile_label})` : ''}. Pools are portfolio × software from the ML dataset, e.g. PF001 / ANSYS.
        </span>
      </div>
      <div className="assistant-log" aria-live="polite" ref={logRef}>
        {turns.length === 0 && (
          <div className="assistant-suggest">
            <div className="label-caps">Try asking</div>
            {suggestions.map((s) => (
              <button key={s} className="suggest" onClick={() => send(s)}>
                {s} <ArrowRight aria-hidden />
              </button>
            ))}
          </div>
        )}
        {turns.map((tn, i) => (
          <div key={i} className="assistant-turn">
            <div className="q">{tn.q}</div>
            <div className="a">
              {tn.pending && <div className="intent mono">Working it out — running the forecast, simulation and engine…</div>}
              {tn.rag && <RagTurn r={tn.rag} onAsk={send} />}
              {tn.local && <LocalTurn a={tn.local} />}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="assistant-input" onSubmit={onSubmit}>
        <input className="input" aria-label="Ask a planning question" placeholder="Ask why, what to do, options, next steps, what if…" value={q} onChange={(e) => setQ(e.target.value)} disabled={busy} />
        <button className="btn primary" type="submit" aria-label="Ask" disabled={busy}>
          <CornerDownLeft />
        </button>
      </form>
    </div>
  );
}

function RagTurn({ r, onAsk }: { r: ChatReply; onAsk: (q: string) => void }) {
  return (
    <>
      <div className="intent mono">
        {QTYPE_LABEL[r.question_type] ?? r.question_type}
        {r.llm_used ? ` · ${r.llm_used}` : ' · composed from model outputs'}
      </div>
      {r.structured ? <StructuredAnswer st={r.structured} llmText={r.llm_used ? r.answer : null} onAsk={onAsk} /> : <Markdown text={r.answer} />}
      {r.notes.filter((n) => !n.startsWith('No LLM configured')).map((n) => (
        <p key={n} className="sa-note">
          {n}
        </p>
      ))}
    </>
  );
}

function LocalTurn({ a }: { a: Answer }) {
  return (
    <>
      <div className="intent mono">{a.intent}</div>
      {a.lines.map((l, j) => (
        <p key={j}>{l}</p>
      ))}
      {a.facts && (
        <dl className="facts">
          {a.facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd className="mono">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {a.links && a.links.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          {a.links.map((l) => (
            <Link key={l.to} to={l.to} className="btn sm">
              {l.label} <ArrowRight />
            </Link>
          ))}
        </div>
      )}
      <div className="src">Source: {a.source}</div>
    </>
  );
}
