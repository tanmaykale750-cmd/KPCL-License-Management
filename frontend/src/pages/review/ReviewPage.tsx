import { Download, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { renewalAdvice } from '../../calc/plan';
import { breakEvenHourly, bridgeFor, costConfidence, invoiceTotal, isSavingRecord, ledgerTotals, priceVolume, robustness, verifiedSaving, type Bridge, type Confidence } from '../../calc/review';
import { BridgeChart } from '../../components/charts/BridgeChart';
import { DataTable } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Overlay';
import { Callout, Empty, Field, PageHead, Panel, SectionLabel } from '../../components/ui/basics';
import { StatusChip } from '../../components/ui/StatusChip';
import type { FinanceInputs, ReviewRecord } from '../../domain/types';
import { downloadCSV } from '../../lib/csv';
import { DEMO_TODAY, fmtDate } from '../../lib/dates';
import { inrShort, num } from '../../lib/format';
import { useApp } from '../../state/store';
import { useWidth } from '../../hooks/useWidth';
import { KIND_LABEL, outcomeChip } from './outcome';
import { ReviewDrawer } from './ReviewDrawer';

function LedgerStrip({ potential, approved, realised, verified }: { potential: number; approved: number; realised: number; verified: number }) {
  const max = Math.max(potential, approved, 1);
  const stages = [
    { key: 'potential', label: 'Potential', value: potential, est: true, note: 'Identified at upcoming renewals — not approved' },
    { key: 'approved', label: 'Approved', value: approved, est: true, note: 'Signed off through the approval workflow' },
    { key: 'realised', label: 'Realised', value: realised, est: true, note: 'Implemented; awaiting or partly matched to invoices' },
    { key: 'verified', label: 'Verified', value: verified, est: false, note: 'Confirmed on vendor invoices or as cost avoided' },
  ];
  return (
    <div className="ledger-strip" role="group" aria-label="Savings ledger">
      {stages.map((s) => (
        <div key={s.key} className={`ledger-stage ${s.key}`}>
          <div className="label-caps">
            {s.label} {s.est ? <span className="chip neutral dashed" style={{ fontSize: 10, padding: '0 5px' }}>estimate</span> : <StatusChip status="verified">evidence</StatusChip>}
          </div>
          <div className={`val${s.est ? ' est-val' : ''}`}>{inrShort(s.value)}</div>
          <div className="note">{s.note}</div>
          <div className="stage-bar" aria-hidden>
            <span className={s.key} style={{ width: `${(s.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function FinanceDialog({ onClose }: { onClose: () => void }) {
  const { state, actions } = useApp();
  const cur = state.finance[0];
  const [rate, setRate] = useState(cur.loadedHourlyCost);
  const [loss, setLoss] = useState(cur.productivityLoss);
  const [measured, setMeasured] = useState(cur.lossFactorMeasured);
  const [basis, setBasis] = useState(cur.basis);
  const [from, setFrom] = useState(DEMO_TODAY);
  const [err, setErr] = useState('');
  const save = () => {
    if (rate < 200 || rate > 20000) return setErr('Hourly cost must be between ₹200 and ₹20,000.');
    if (loss <= 0 || loss > 1) return setErr('Loss factor must be above 0 and at most 1.');
    if (basis.trim().length < 15) return setErr('Describe the basis of the rate (at least 15 characters).');
    actions.updateFinance({ loadedHourlyCost: rate, productivityLoss: loss, lossFactorMeasured: measured, rateApproved: true, basis: basis.trim(), effectiveFrom: from });
    onClose();
  };
  return (
    <Dialog
      title="New finance input version"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save as {`FIN-2026.${state.finance.length}`}
          </button>
        </>
      }
    >
      <p className="small muted">Earlier decisions keep the version in force when they were made. New plans and reviews use this version.</p>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <Field label="Loaded hourly cost (₹/h)" htmlFor="fin-rate" error={err || undefined}>
          <input id="fin-rate" type="number" className="input" value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        </Field>
        <Field label="Productivity loss factor (0–1)" htmlFor="fin-loss" hint="Share of a blocked hour that is truly lost">
          <input id="fin-loss" type="number" step={0.05} min={0} max={1} className="input" value={loss} onChange={(e) => setLoss(Number(e.target.value))} />
        </Field>
        <Field label="Effective from" htmlFor="fin-from">
          <input id="fin-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Loss factor source" htmlFor="fin-meas">
          <select id="fin-meas" className="select" value={measured ? 'm' : 'd'} onChange={(e) => setMeasured(e.target.value === 'm')}>
            <option value="d">Default assumption</option>
            <option value="m">Measured (denial follow-up survey)</option>
          </select>
        </Field>
        <Field label="Basis" htmlFor="fin-basis" full>
          <textarea id="fin-basis" className="input" rows={3} value={basis} onChange={(e) => setBasis(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** One record's savings-versus-blocked-time figures. Computed once and shared by the summary, the comparison bars and the table. */
interface TradeOff {
  r: ReviewRecord;
  saving: number; // annual licence saving: verified when evidenced, otherwise the approved value (estimate)
  savingVerified: boolean;
  hours: number; // blocked engineering hours: measured since the change, otherwise the estimate at approval
  hoursMeasured: boolean;
  lostHours: number; // blocked hours × productivity-loss factor
  cost: number; // cost of blocked time at the test rate
  net: number;
  breakEven: number;
  verdict: 'robust' | 'sensitive';
  confidence: Confidence;
}

function tradeOffFor(r: ReviewRecord, rate: number, fin: FinanceInputs): TradeOff {
  const verified = verifiedSaving(r);
  const saving = verified || r.approvedValue;
  const hoursMeasured = r.measuredBlockedHours !== undefined;
  const hours = r.measuredBlockedHours ?? r.estBlockedHours;
  const cost = hours * rate * fin.productivityLoss;
  const breakEven = breakEvenHourly(saving, hours, fin.productivityLoss);
  return {
    r,
    saving,
    savingVerified: verified > 0,
    hours,
    hoursMeasured,
    lostHours: hours * fin.productivityLoss,
    cost,
    net: saving - cost,
    breakEven,
    verdict: robustness(breakEven, rate),
    // Denial data exists once shortages have been monitored after the change.
    confidence: costConfidence(fin, hoursMeasured, r.shortagesAfter !== null),
  };
}

const CONF_RANK: Record<Confidence, number> = { Low: 0, Medium: 1, High: 2 };
const CONF_TITLE: Record<Confidence, string> = {
  High: 'Measured blocked hours and measured loss factor',
  Medium: 'Default loss factor or estimated blocked hours',
  Low: 'Rate not approved or no denial data',
};

function noBridgeReason(r: ReviewRecord): string {
  if (r.kind === 'reallocation') return 'Re-hosting has no invoice change';
  if (r.kind === 'token-mix') return 'Token mix changes the product, so price and volume are not comparable';
  return 'Awaiting invoice evidence';
}

/** Annual saving against the cost of blocked time, on a shared scale. */
function PairBar({ saving, cost, max }: { saving: number; cost: number; max: number }) {
  const w = (v: number) => (v > 0 ? `max(2px, ${Math.min(100, (v / (max || 1)) * 100)}%)` : '0');
  return (
    <span className="pair-bar" aria-hidden>
      <span className="track"><span className="save" style={{ width: w(saving) }} /></span>
      <span className="track"><span className="cost" style={{ width: w(cost) }} /></span>
    </span>
  );
}

export default function ReviewPage() {
  const { ds, state, perms } = useApp();
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const fin = state.finance[0];
  const [testRate, setTestRate] = useState(fin.loadedHourlyCost);
  const [finOpen, setFinOpen] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  // The bridge is drawn at its panel's real width so labels stay full size on any screen.
  const [bridgeRef, bridgeW] = useWidth<HTMLDivElement>(720);

  const records = useMemo(
    () => state.review.filter((r) => !perms.deptScope || (ds.licences.find((l) => l.id === r.licenceId)?.allocations[perms.deptScope] ?? 0) > 0),
    [state.review, ds, perms.deptScope],
  );
  const potential = useMemo(() => ds.licences.map((l) => renewalAdvice(ds, l.id)).reduce((a, x) => a + x.annualSaving, 0), [ds]);
  const totals = ledgerTotals(records, potential);
  const spendRecords = records.filter((r) => !isSavingRecord(r));
  const savingRecords = records.filter(isSavingRecord);
  const open = records.find((r) => r.id === openId) ?? null;
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('open', id);
    else next.delete('open');
    setParams(next, { replace: true });
  };
  const product = (licenceId: string) => ds.licences.find((l) => l.id === licenceId)?.product ?? licenceId;

  // Bridge: selected record, otherwise the sum over records with invoice evidence.
  const withBridge = records.map((r) => ({ r, b: bridgeFor(r) })).filter((x): x is { r: ReviewRecord; b: Bridge } => !!x.b);
  const sel = withBridge.find((x) => x.r.id === selId);
  const agg: Bridge = withBridge.reduce((a, { b }) => ({ before: a.before + b.before, volume: a.volume + b.volume, price: a.price + b.price, after: a.after + b.after, invoiceChange: a.invoiceChange + b.invoiceChange }), priceVolume(0, 0, 0, 0));
  const bridge = sel?.b ?? agg;
  const selNoBridge = selId && !sel ? records.find((r) => r.id === selId) : undefined;

  const notImpl = records.filter((r) => r.state === 'not-implemented');
  const tradeRows = records.filter((r) => isSavingRecord(r) && r.state !== 'not-implemented');
  const trade = tradeRows.map((r) => tradeOffFor(r, testRate, fin));
  const tt = trade.reduce(
    (a, t) => ({
      saving: a.saving + t.saving,
      verified: a.verified + (t.savingVerified ? t.saving : 0),
      hours: a.hours + t.hours,
      measuredHours: a.measuredHours + (t.hoursMeasured ? t.hours : 0),
      estAtApproval: a.estAtApproval + t.r.estBlockedHours,
      lostHours: a.lostHours + t.lostHours,
      cost: a.cost + t.cost,
      net: a.net + t.net,
    }),
    { saving: 0, verified: 0, hours: 0, measuredHours: 0, estAtApproval: 0, lostHours: 0, cost: 0, net: 0 },
  );
  const portfolioBE = breakEvenHourly(tt.saving, tt.hours, fin.productivityLoss);
  const portfolioVerdict = robustness(portfolioBE, testRate);
  const weakest = trade.length ? trade.reduce((m, t) => (t.breakEven < m.breakEven ? t : m)) : null;
  const lowestConf = trade.length ? trade.reduce((m, t) => (CONF_RANK[t.confidence] < CONF_RANK[m.confidence] ? t : m)).confidence : null;
  const pairMax = Math.max(1, ...trade.map((t) => Math.max(t.saving, t.cost)));
  const verMax = Math.max(1, ...savingRecords.map((r) => Math.max(r.approvedValue, verifiedSaving(r))));

  const invoiceRows = state.invoices
    .map((l) => ({ l, r: records.find((r) => r.invoiceLineIds.includes(l.id)) }))
    .filter((x): x is { l: (typeof state.invoices)[number]; r: ReviewRecord } => !!x.r);

  const exportCsv = () =>
    downloadCSV(
      'review-outcome-register-sample.csv',
      records.map((r) => ({
        record: r.id,
        cycle: r.cycle,
        action: r.title,
        kind: KIND_LABEL[r.kind],
        approved_value_inr: r.approvedValue,
        verified_saving_inr: verifiedSaving(r),
        state: r.state,
        po: r.poRef ?? '',
        invoices: state.invoices.filter((l) => r.invoiceLineIds.includes(l.id)).map((l) => l.invoiceNo).join(' '),
        blocked_hours_after: r.shortagesAfter?.blockedHours ?? '',
      })),
    );

  const verifiedPct = totals.approved > 0 ? Math.round((totals.verified / totals.approved) * 100) : null;

  return (
    <>
      <PageHead
        title="Review & Savings"
        sub="What was approved, what was implemented, and what the invoices show."
        actions={
          <button className="btn" onClick={exportCsv}>
            <Download /> Export register
          </button>
        }
      />
      {perms.deptScope && <div className="scope-note">Showing records for licences used by your department.</div>}

      {/* ── 1 · Financial analytics ─────────────────────────────── */}
      <LedgerStrip {...totals} />
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        Only the <b>verified</b> column is a saving. Grey figures with “est.” are estimates; the vendor’s price changes are never counted as savings.
      </p>

      <div className="review-analytics section-gap">
        <Panel
          title={sel ? `Invoice bridge · ${sel.r.id}` : 'Invoice bridge · all invoiced records'}
          sub={sel ? sel.r.title : selNoBridge ? `${selNoBridge.id} has no invoice bridge (${noBridgeReason(selNoBridge).toLowerCase()}) — showing all invoiced records` : 'Last-cycle invoices → this cycle, split into volume and price'}
          actions={selId ? <button className="link-btn small" onClick={() => setSelId(null)}>Show all</button> : undefined}
          footer={<span className="takeaway">Volume effect <b>{inrShort(bridge.volume, { sign: true })}</b> is credited; price effect <b>{inrShort(bridge.price, { sign: true })}</b> is the vendor’s price change and is not.</span>}
        >
          <div ref={bridgeRef}>
            <BridgeChart b={bridge} height={325} width={Math.max(360, Math.round(bridgeW))} />
          </div>
        </Panel>

        <Panel
          title="Approved vs verified · by record"
          sub="Savings records · select one to show its invoice bridge"
          footer={
            verifiedPct !== null ? (
              <span className="takeaway">
                <b>{inrShort(totals.verified)}</b> verified of {inrShort(totals.approved)} approved ({verifiedPct}%). Approved values stay estimates until evidenced.
              </span>
            ) : undefined
          }
        >
          {savingRecords.length === 0 && <p className="small muted">No savings records yet.</p>}
          <div className="vr-list">
            {savingRecords.map((r) => {
              const v = verifiedSaving(r);
              const hasBridge = !!bridgeFor(r);
              return (
                <div key={r.id} className={`vr-item${selId === r.id ? ' active' : ''}`}>
                  <button className="vr-main" onClick={() => setSelId(selId === r.id ? null : r.id)} aria-pressed={selId === r.id} title={hasBridge ? 'Show this record’s invoice bridge' : noBridgeReason(r)}>
                    <span className="vr-top">
                      <span className="mono">{r.id}</span>
                      {outcomeChip(r)}
                      {!hasBridge && <span className="vr-note">no invoice bridge</span>}
                    </span>
                    <span className="vr-title">{r.title}</span>
                    <span className="vr-bar">
                      <span className="lbl">Approved</span>
                      <span className="stage-bar"><span className="approved" style={{ width: `${(r.approvedValue / verMax) * 100}%` }} /></span>
                      <span className="est mono">{inrShort(r.approvedValue)}</span>
                    </span>
                    <span className="vr-bar">
                      <span className="lbl">Verified</span>
                      <span className="stage-bar"><span className="verified" style={{ width: `${(v / verMax) * 100}%` }} /></span>
                      {v > 0 ? <b className="mono" style={{ color: 'var(--teal-strong)', fontWeight: 600 }}>{inrShort(v)}</b> : <span className="mono muted">—</span>}
                    </span>
                  </button>
                  <button className="link-btn small vr-evidence" onClick={() => setOpen(r.id)}>
                    Evidence
                  </button>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* ── 2 · Savings vs Trade-off ────────────────────────────── */}
      <SectionLabel>Savings vs Trade-off</SectionLabel>
      <div className="tradeoff-toolbar">
        <span className="small muted">
          Is the licence saving still worth it after the engineering time it blocks? Figures use the test rate; Finance’s rate in force is <b className="mono">{fin.version}</b> at ₹{num(fin.loadedHourlyCost)}/h with loss factor {fin.productivityLoss} ({fin.lossFactorMeasured ? 'measured' : 'default assumption'}).
        </span>
        <div className="sens-row">
          <label htmlFor="rate-test" className="nowrap">
            Test rate <b className="mono">₹{num(testRate)}/h</b>
          </label>
          <input id="rate-test" type="range" min={500} max={6000} step={100} value={testRate} onChange={(e) => setTestRate(Number(e.target.value))} />
          {testRate !== fin.loadedHourlyCost && (
            <button className="link-btn small nowrap" onClick={() => setTestRate(fin.loadedHourlyCost)}>
              Reset to {fin.version}
            </button>
          )}
        </div>
      </div>
      {!fin.rateApproved && (
        <Callout tone="warn">The loaded hourly rate in {fin.version} is not approved by Finance, so every trade-off below has Low confidence.</Callout>
      )}

      {trade.length === 0 ? (
        <Panel title="Trade-off">
          <Empty title="Not enough data for a trade-off yet">
            <span className="small muted" style={{ display: 'block', marginTop: 4 }}>
              The trade-off needs an implemented savings record with blocked-hour data. Nothing is estimated in its place.
            </span>
          </Empty>
        </Panel>
      ) : (
        <>
          <div className="tradeoff-strip" role="group" aria-label="Savings versus trade-off summary">
            <div className="tradeoff-cell">
              <div className="label-caps">Annual licence saving <span className="chip neutral dashed" style={{ fontSize: 10, padding: '0 5px' }}>gross</span></div>
              <div className="val">{inrShort(tt.saving)}</div>
              <div className="note">
                <b style={{ color: 'var(--teal-strong)', fontWeight: 600 }}>{inrShort(tt.verified)}</b> verified · <span className="est">{inrShort(tt.saving - tt.verified)}</span> approved, not yet verified
              </div>
            </div>
            <div className="tradeoff-cell">
              <div className="label-caps">Blocked engineering hours</div>
              <div className="val">{num(tt.hours)} h</div>
              <div className="note">
                {num(tt.measuredHours)} h measured since the change · {num(tt.hours - tt.measuredHours)} h estimated
                <br />
                Estimated at approval: <span className="est">{num(tt.estAtApproval)} h</span>
                <br />
                <span title="Review records store one estimate and one measurement; no P50–P90 forecast range is recorded for them.">Range: not recorded</span>
              </div>
            </div>
            <div className="tradeoff-cell">
              <div className="label-caps">Productivity loss</div>
              <div className="val est-val">
                <span className="est">{inrShort(tt.cost)}</span>
              </div>
              <div className="note">
                {num(tt.lostHours, 1)} h lost = {num(tt.hours)} h × loss factor {fin.productivityLoss}, at ₹{num(testRate)}/h
              </div>
            </div>
            <div className="tradeoff-cell">
              <div className="label-caps">Net benefit after blocked time <span className="chip neutral dashed" style={{ fontSize: 10, padding: '0 5px' }}>estimate</span></div>
              <div className="val" style={{ color: tt.net >= 0 ? 'var(--teal-strong)' : 'var(--crit)' }}>{inrShort(tt.net, { sign: true })}</div>
              <div className="note">Annual saving − cost of blocked time. Blocked time uses {tt.saving > 0 ? `${((tt.cost / tt.saving) * 100).toFixed(tt.cost / tt.saving < 0.01 ? 2 : 1)}%` : '—'} of the saving.</div>
              <PairBar saving={tt.saving} cost={tt.cost} max={Math.max(tt.saving, tt.cost)} />
            </div>
            <div className="tradeoff-cell">
              <div className="label-caps">Break-even hourly cost</div>
              <div className="val">{portfolioBE === Infinity ? <span className="muted" title="No blocked time recorded">—</span> : `₹${num(portfolioBE)}/h`}</div>
              <div className="note">
                {portfolioBE !== Infinity && (portfolioVerdict === 'robust' ? <StatusChip status="healthy">Robust</StatusChip> : <StatusChip status="forecast-shortage">Sensitive</StatusChip>)}{' '}
                {weakest && weakest.breakEven !== Infinity && (
                  <>
                    Most sensitive: <span className="mono">{weakest.r.id}</span> at ₹{num(weakest.breakEven)}/h.
                  </>
                )}
                <br />
                Lowest confidence: <b style={{ fontWeight: 600 }} title={lowestConf ? CONF_TITLE[lowestConf] : undefined}>{lowestConf}</b>
              </div>
            </div>
          </div>

          <Panel flush className="section-gap" title="Was the saving worth the blocked time?" sub="Per record: annual saving against the cost of engineering time blocked after the change">
            <DataTable
              rows={trade}
              rowKey={(t) => t.r.id}
              onRowClick={(t) => setOpen(t.r.id)}
              columns={[
                { key: 'r', header: 'Record', render: (t) => <span><span className="mono">{t.r.id}</span> <span className="small muted">· {product(t.r.licenceId)}</span><span className="sub">{t.r.title}</span></span> },
                { key: 's', header: 'Saving / yr', num: true, render: (t) => (t.savingVerified ? <b style={{ fontWeight: 600, color: 'var(--teal-strong)' }} title="Verified saving">{inrShort(t.saving)}</b> : <span className="est" title="Approved value — not yet verified">{inrShort(t.saving)}</span>), sort: (t) => t.saving },
                {
                  key: 'h',
                  header: 'Blocked h',
                  num: true,
                  title: 'Measured since the change when recorded; otherwise the estimate at approval',
                  render: (t) => (
                    <span>
                      {t.hoursMeasured ? <span title="Measured since the change">{num(t.hours)}</span> : <span className="est">{num(t.hours)}</span>}
                      <span className="sub">{t.hoursMeasured ? `est. ${num(t.r.estBlockedHours)} at approval` : 'not measured yet'}</span>
                    </span>
                  ),
                  sort: (t) => t.hours,
                },
                { key: 'c', header: 'Blocked cost', num: true, render: (t) => <span className="est">{inrShort(t.cost)}</span>, sort: (t) => t.cost },
                { key: 'cmp', header: 'Saving vs blocked cost', width: 150, render: (t) => <PairBar saving={t.saving} cost={t.cost} max={pairMax} /> },
                { key: 'n', header: 'Net', num: true, render: (t) => <b style={{ fontWeight: 600, color: t.net >= 0 ? 'var(--teal-strong)' : 'var(--crit)' }}>{inrShort(t.net, { sign: true })}</b>, sort: (t) => t.net },
                {
                  key: 'be',
                  header: 'Break-even',
                  num: true,
                  title: 'Hourly cost at which the blocked time would cancel out the saving',
                  render: (t) => (t.breakEven === Infinity ? <span className="muted" title="No blocked time recorded after the change">—</span> : `₹${num(t.breakEven)}/h`),
                  sort: (t) => (t.breakEven === Infinity ? Number.MAX_VALUE : t.breakEven),
                },
                { key: 'rb', header: 'Verdict', render: (t) => (t.verdict === 'robust' ? <StatusChip status="healthy">Robust</StatusChip> : <StatusChip status="forecast-shortage">Sensitive</StatusChip>) },
                { key: 'cf', header: 'Confidence', render: (t) => <span className="small" title={CONF_TITLE[t.confidence]}>{t.confidence}</span>, sort: (t) => CONF_RANK[t.confidence] },
              ]}
            />
            <div className="pair-legend small muted">
              <span><i className="save" /> Annual saving</span>
              <span><i className="cost" /> Cost of blocked time at ₹{num(testRate)}/h</span>
            </div>
          </Panel>
        </>
      )}

      <div className="review-tradeoff-notes section-gap">
        <Panel title="How the trade-off is calculated" sub="Assumptions and inputs behind every figure above">
          <dl className="dl calc-dl">
            <dt>Annual saving</dt>
            <dd>Verified saving (volume effect on invoices, or cost avoided) when evidenced; otherwise the approved value, shown as an estimate. Gross — never net of blocked time.</dd>
            <dt>Blocked hours</dt>
            <dd>Measured since the change when recorded; otherwise the estimate at approval. Hours are as recorded on the review record (not annualised), and no P50–P90 range is stored for them.</dd>
            <dt>Cost of blocked time</dt>
            <dd className="mono small">blocked h × test rate (₹/h) × loss factor ({fin.productivityLoss})</dd>
            <dt>Net benefit</dt>
            <dd className="mono small">annual saving − cost of blocked time</dd>
            <dt>Break-even rate</dt>
            <dd><span className="mono small">annual saving ÷ (blocked h × loss factor)</span> — <b>robust</b> when at least twice the test rate, otherwise <b>sensitive</b>.</dd>
            <dt>Confidence</dt>
            <dd>High: measured blocked hours and measured loss factor. Medium: default loss factor or estimated hours. Low: rate not approved, or no denial data since the change.</dd>
          </dl>
        </Panel>
        <Panel
          title="Finance inputs"
          sub="Versioned · owned by Finance"
          actions={
            perms.editFinanceInputs ? (
              <button className="btn sm" onClick={() => setFinOpen(true)}>
                <Plus /> New version
              </button>
            ) : undefined
          }
          footer={<span className="takeaway">A result is <b>robust</b> when the break-even rate is at least twice the approved rate; otherwise it is <b>sensitive</b> to the rate assumption.</span>}
        >
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Version</th>
                <th className="num">₹/h</th>
                <th className="num">Loss</th>
                <th className="num">From</th>
              </tr>
            </thead>
            <tbody>
              {state.finance.map((f, i) => (
                <tr key={f.version}>
                  <td>
                    <span className="mono">{f.version}</span>
                    <span className="sub">{i === 0 ? 'In force · ' : ''}{f.lossFactorMeasured ? 'loss measured' : 'loss default'}</span>
                  </td>
                  <td className="num">{num(f.loadedHourlyCost)}</td>
                  <td className="num">{f.productivityLoss}</td>
                  <td className="num">{fmtDate(f.effectiveFrom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 8 }}>{fin.basis}</p>
        </Panel>
      </div>

      {/* ── 3 · Supporting review features ──────────────────────── */}
      <SectionLabel>Implementation follow-up and evidence</SectionLabel>
      <div className="review-support">
        <Panel flush title="Invoice evidence" sub={`${invoiceRows.length} invoice lines linked to review records · click a line for the record`}>
          <DataTable
            rows={invoiceRows}
            rowKey={(x) => x.l.id}
            onRowClick={(x) => setOpen(x.r.id)}
            initialSort={{ key: 'd', dir: 'desc' }}
            empty={<div className="empty">No invoice lines attached yet.</div>}
            columns={[
              { key: 'i', header: 'Invoice', render: (x) => <span><span className="mono">{x.l.invoiceNo}</span><span className="sub mono">{x.l.poRef}</span></span>, sort: (x) => x.l.invoiceNo },
              { key: 'd', header: 'Date', render: (x) => <span className="nowrap">{fmtDate(x.l.date)}</span>, sort: (x) => x.l.date },
              { key: 'sw', header: 'Software', render: (x) => product(x.l.licenceId), sort: (x) => product(x.l.licenceId) },
              { key: 'rec', header: 'Record', render: (x) => <span className="mono">{x.r.id}</span>, sort: (x) => x.r.id },
              { key: 'q', header: 'Qty', num: true, render: (x) => num(x.l.quantity), sort: (x) => x.l.quantity },
              { key: 'u', header: 'Unit price', num: true, render: (x) => inrShort(x.l.unitPrice), sort: (x) => x.l.unitPrice },
              { key: 't', header: 'Line total', num: true, render: (x) => inrShort(invoiceTotal([x.l])), sort: (x) => invoiceTotal([x.l]) },
            ]}
          />
        </Panel>
        <Panel title="Fed back to planning" sub="Reasons actions were not implemented">
          {notImpl.length ? (
            notImpl.map((r) => (
              <div key={r.id} className="small" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <span className="mono">{r.id}</span> · {r.title}
                <div className="muted">{r.notImplementedReason}</div>
              </div>
            ))
          ) : (
            <p className="small muted">None this cycle.</p>
          )}
        </Panel>
      </div>

      {spendRecords.length > 0 && (
        <>
          <SectionLabel>Spend approved to protect projects</SectionLabel>
          <Panel flush title="Purchases and temporary access" sub="Costs, not savings — reviewed for blocked hours avoided">
            <DataTable
              ledger
              rows={spendRecords}
              rowKey={(r) => r.id}
              onRowClick={(r) => setOpen(r.id)}
              columns={[
                { key: 'r', header: 'Record', render: (r) => <span><span className="mono">{r.id}</span><span className="sub">{r.title}</span></span> },
                { key: 'k', header: 'Action', render: (r) => KIND_LABEL[r.kind] },
                { key: 'c', header: 'Approved cost', num: true, render: (r) => <span className="est">{inrShort(Math.abs(r.approvedValue))}</span> },
                { key: 'h', header: 'Blocked h expected', num: true, render: (r) => r.estBlockedHours },
                { key: 's', header: 'Status', render: (r) => outcomeChip(r) },
              ]}
            />
          </Panel>
        </>
      )}

      {/* ── 4 · Outcome register ────────────────────────────────── */}
      <SectionLabel>Outcome register</SectionLabel>
      <Panel flush title="Outcome register" sub={`${records.length} approved actions · click a row for evidence`}>
        <DataTable
          ledger
          rows={records}
          rowKey={(r) => r.id}
          onRowClick={(r) => {
            setSelId(r.id);
            setOpen(r.id);
          }}
          selectedKey={selId}
          initialSort={{ key: 'at', dir: 'desc' }}
          columns={[
            { key: 'id', header: 'Record', render: (r) => <span><span className="mono">{r.id}</span> <span className="small muted">· {KIND_LABEL[r.kind]}</span><span className="sub">{r.title}</span></span>, sort: (r) => r.id },
            { key: 'sw', header: 'Software', render: (r) => <span>{product(r.licenceId)}<span className="sub mono">{r.licenceId}</span></span>, sort: (r) => product(r.licenceId) },
            { key: 'at', header: 'Approved', render: (r) => <span><span className="nowrap">{fmtDate(r.approvedAt.slice(0, 10))}</span><span className="sub">{r.approvedBy}</span></span>, sort: (r) => r.approvedAt },
            { key: 'a', header: 'Approved / yr', num: true, render: (r) => (r.approvedValue >= 0 ? <span className="est">{inrShort(r.approvedValue)}</span> : <span className="est" title="Spend approved to protect projects — not a saving">cost {inrShort(-r.approvedValue)}</span>), sort: (r) => r.approvedValue },
            { key: 'v', header: 'Verified', num: true, render: (r) => (verifiedSaving(r) > 0 ? <b style={{ fontWeight: 600, color: 'var(--teal-strong)' }}>{inrShort(verifiedSaving(r))}</b> : <span className="muted">—</span>), sort: (r) => verifiedSaving(r) },
            { key: 's', header: 'Status', render: (r) => outcomeChip(r), sort: (r) => r.state },
            { key: 'e', header: 'Docs', num: true, render: (r) => <span className="mono small">{r.invoiceLineIds.length ? `${r.invoiceLineIds.length} inv` : r.poRef ? 'PO' : '—'}</span> },
          ]}
          footer={
            <tr>
              <td colSpan={3}>Total (savings records)</td>
              <td className="num">{inrShort(totals.approved)}</td>
              <td className="num">{inrShort(totals.verified)}</td>
              <td colSpan={2} />
            </tr>
          }
        />
      </Panel>

      {perms.deptScope === null && state.review.length === 0 && <Callout>No review records yet.</Callout>}
      {open && <ReviewDrawer r={open} onClose={() => setOpen(null)} />}
      {finOpen && <FinanceDialog onClose={() => setFinOpen(false)} />}
    </>
  );
}
