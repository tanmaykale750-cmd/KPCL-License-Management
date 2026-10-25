import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { useSession } from '../../api/session';
import { Callout, Panel } from '../../components/ui/basics';

/**
 * Live model panel: the trained ensemble's 6-month pool forecast, the recommendation engine's decision for the pool,
 * and (for roles with the 'simulate' scope) a what-if run through the Monte Carlo simulation. Everything is computed
 * by the backend modules; this component only displays it.
 */

interface MonthRow {
  month: string;
  peak_p50: number;
  peak_p90: number;
  licences_owned: number;
  shortage_probability: number;
  licences_needed: number;
  at_risk: boolean;
}
interface Pools {
  portfolios: string[];
  software: { software_id: string; software_name: string }[];
}
interface WhatIfReply {
  valid: boolean;
  errors: string[];
  description: string;
  summary: Record<string, number>;
  engine_recommendation: Record<string, unknown>[] | null;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function EnginePanel() {
  const session = useSession();
  const [pools, setPools] = useState<Pools | null>(null);
  const [pf, setPf] = useState('PF001');
  const [sw, setSw] = useState('SW003');
  const [rows, setRows] = useState<MonthRow[] | null>(null);
  const [rec, setRec] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [add, setAdd] = useState(0);
  const [temp, setTemp] = useState(0);
  const [wi, setWi] = useState<WhatIfReply | null>(null);
  const canRecommend = session.scopes.includes('recommend');
  const canSimulate = session.scopes.includes('simulate');

  useEffect(() => {
    api.get<Pools>('/pools').then(setPools).catch((e: ApiError) => setErr(e.message));
  }, []);

  useEffect(() => {
    setRows(null);
    setRec(null);
    setWi(null);
    setErr(null);
    const q = `portfolio_id=${encodeURIComponent(pf)}&software_id=${encodeURIComponent(sw)}`;
    api.get<{ monthly: MonthRow[] }>(`/forecast?${q}`).then((r) => setRows(r.monthly)).catch((e: ApiError) => setErr(e.message));
    if (canRecommend) {
      api.get<{ recommendation: Record<string, unknown> | null }>(`/recommendation?${q}`).then((r) => setRec(r.recommendation)).catch(() => setRec(null));
    }
  }, [pf, sw, canRecommend]);

  const runWhatIf = () => {
    setWi(null);
    api
      .post<WhatIfReply>('/whatif', { portfolio_id: pf, software_id: sw, licence_change: add, temp_licences: temp })
      .then(setWi)
      .catch((e: ApiError) => setErr(e.message));
  };

  const action = rec ? String(rec.action ?? '') : '';
  return (
    <Panel
      title="Live model: ensemble forecast"
      sub="Licence-pool forecast from the trained ensemble, with the recommendation engine's decision. Pools follow the ML dataset (portfolio × software)."
      actions={
        <>
          <select className="select" aria-label="Portfolio" value={pf} onChange={(e) => setPf(e.target.value)}>
            {(pools?.portfolios ?? [pf]).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select className="select" aria-label="Software" value={sw} onChange={(e) => setSw(e.target.value)}>
            {(pools?.software ?? [{ software_id: sw, software_name: sw }]).map((s) => (
              <option key={s.software_id} value={s.software_id}>
                {s.software_name}
              </option>
            ))}
          </select>
        </>
      }
    >
      {err && <Callout tone="warn">{err}</Callout>}
      {!rows && !err && <div className="small muted">Running the ensemble…</div>}
      {rows && (
        <table className="statement">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Peak P50</th>
              <th className="num">Peak P90</th>
              <th className="num">Owned</th>
              <th className="num">Needed (95%)</th>
              <th className="num">Shortage chance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month}>
                <td>{r.month}{r.at_risk ? ' · at risk' : ''}</td>
                <td className="num">{r.peak_p50}</td>
                <td className="num">{r.peak_p90}</td>
                <td className="num">{r.licences_owned}</td>
                <td className="num">{r.licences_needed}</td>
                <td className="num">{pct(r.shortage_probability)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canRecommend && rec && (
        <p className="small" style={{ marginTop: 8 }}>
          <b>Recommendation engine:</b> {action.replace(/_/g, ' ').toLowerCase() || 'see details'}
          {typeof rec.reason === 'string' ? ` — ${rec.reason}` : ''}
          {typeof rec.approval_status === 'string' ? ` (${String(rec.approval_status).replace(/_/g, ' ').toLowerCase()})` : ''}
        </p>
      )}
      {canSimulate && (
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
          <label className="field-inline">
            <span>Add licences</span>
            <input className="input" type="number" style={{ width: 80 }} value={add} onChange={(e) => setAdd(Number(e.target.value))} />
          </label>
          <label className="field-inline">
            <span>Temporary / month</span>
            <input className="input" type="number" min={0} style={{ width: 80 }} value={temp} onChange={(e) => setTemp(Number(e.target.value))} />
          </label>
          <button className="btn" onClick={runWhatIf}>
            Simulate what-if
          </button>
        </div>
      )}
      {wi && (
        <Callout tone={wi.valid ? 'ok' : 'warn'}>
          {wi.valid
            ? `${wi.description}: months at risk ${wi.summary.months_at_risk_before} → ${wi.summary.months_at_risk_after}; expected shortage ${wi.summary.expected_shortage_licence_months_before.toFixed(1)} → ${wi.summary.expected_shortage_licence_months_after.toFixed(1)} licence-months; added cost ₹${Math.round(wi.summary.added_cost_inr).toLocaleString('en-IN')}.`
            : `Not valid: ${wi.errors.join('; ')}`}
        </Callout>
      )}
    </Panel>
  );
}
