import { Download, Info, Lock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  denialHeatmap,
  departmentBreakdown,
  idleByTeam,
  licenceRows,
  monthlyTrend,
  nextRenewals,
  periodMonths,
  rarelyUsed,
  summarise,
  unusedBuckets,
  type Filters,
} from '../../calc/metrics';
import { renewalAdvice } from '../../calc/plan';
import { ledgerTotals } from '../../calc/review';
import { DeptSpendBars } from '../../components/charts/DeptSpendBars';
import { SpendDonut } from '../../components/charts/SpendDonut';
import { TrendChart } from '../../components/charts/TrendChart';
import { SoftwareDrawer } from '../../components/records/SoftwareDrawer';
import { DataTable } from '../../components/ui/DataTable';
import { StatusChip, UtilChip } from '../../components/ui/StatusChip';
import { MiniBar, PageHead, Panel, SectionLabel } from '../../components/ui/basics';
import { useForecasts } from '../../hooks/useForecasts';
import { downloadCSV } from '../../lib/csv';
import { fmtDate } from '../../lib/dates';
import { hours, inrShort, num, pct } from '../../lib/format';
import { scopedFilters, useApp } from '../../state/store';
import { KeyActions } from './KeyActions';
import { MetricDrawer, type MetricKey } from './MetricDrawer';
import { FilterBar } from './FilterBar';

function Kpi({ label, value, unit, meta, onClick, title }: { label: string; value: string; unit?: string; meta: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button className="kpi" onClick={onClick} title={title}>
      <div className="kpi-label">
        {label}
        <Info className="info" aria-hidden />
      </div>
      <div className="kpi-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="kpi-meta">{meta}</div>
    </button>
  );
}

function DeltaPts({ now, prev, goodWhen }: { now: number; prev: number; goodWhen: 'up' | 'down' }) {
  const d = (now - prev) * 100;
  const flat = Math.abs(d) < 0.5;
  const good = (d > 0 && goodWhen === 'up') || (d < 0 && goodWhen === 'down');
  return (
    <span className={`delta ${flat ? 'flat' : good ? 'good' : 'bad'}`}>
      {flat ? '±0' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`} pts
    </span>
  );
}

function DeltaRel({ now, prev, goodWhen }: { now: number; prev: number; goodWhen: 'up' | 'down' }) {
  if (prev <= 0) return null;
  const d = now / prev - 1;
  const flat = Math.abs(d) < 0.005;
  const good = (d > 0 && goodWhen === 'up') || (d < 0 && goodWhen === 'down');
  return (
    <span className={`delta ${flat ? 'flat' : good ? 'good' : 'bad'}`}>
      {d > 0 ? '+' : '−'}
      {Math.abs(d * 100).toFixed(0)}%
    </span>
  );
}

export function OverviewPage() {
  const { ds, state, perms, actions } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const filters = scopedFilters(state.filters, perms);
  const [metric, setMetric] = useState<MetricKey | null>(null);
  const [openLic, setOpenLic] = useState<string | null>(null);
  const fc = useForecasts();

  const s = useMemo(() => summarise(ds, filters), [ds, filters]);
  const prev = useMemo(() => summarise(ds, filters, 1), [ds, filters]);
  const company = useMemo(() => summarise(ds, { ...filters, deptId: 'all' }), [ds, filters]);
  const depts = useMemo(() => departmentBreakdown(ds, { ...filters, deptId: 'all' }), [ds, filters]);
  const rows = useMemo(() => licenceRows(ds, filters), [ds, filters]);
  const trend = useMemo(() => monthlyTrend(ds, filters, 12), [ds, filters]);
  const unused = useMemo(() => unusedBuckets(ds, filters), [ds, filters]);
  const teams = useMemo(() => idleByTeam(ds, filters).slice(0, 6), [ds, filters]);
  const rare = useMemo(() => rarelyUsed(ds, filters).slice(0, 5), [ds, filters]);
  const renewals = useMemo(() => nextRenewals(ds, filters, 183), [ds, filters]);
  const heat = useMemo(() => denialHeatmap(ds, 'ANS-MECH', periodMonths(12)), [ds]);

  useEffect(() => {
    if (loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loc.hash]);

  const scoped = !!perms.deptScope;
  const deptName = ds.departments.find((d) => d.id === filters.deptId)?.name;
  const deptRows = scoped
    ? (() => {
        const own = depts.find((d) => d.deptId === perms.deptScope)!;
        const others = depts.filter((d) => d.deptId !== perms.deptScope);
        const spend = others.reduce((a, d) => a + d.spend, 0);
        const used = others.reduce((a, d) => a + d.usedSpend, 0);
        return [own, { deptId: 'others', name: 'Other depts', spend, usedSpend: used, idleSpend: spend - used, util: used / spend, seats: 0, blocked: 0, muted: true }];
      })()
    : depts;

  const biggest = [...depts].sort((a, b) => b.idleSpend - a.idleSpend)[0];
  const slices = [
    { key: 'use', label: 'In active use', value: s.split.inUse, color: 'var(--chart-used)', note: 'Checked out and active (working-hours basis).' },
    { key: 'idle', label: 'Idle check-outs', value: s.split.idleCheckout, color: 'var(--chart-idle)', note: 'Checked out with no activity — recoverable with an idle time-out.' },
    { key: 'unused', label: 'Unused capacity', value: s.split.unused, color: 'var(--chart-unused)', note: 'Seats not checked out at all. Part of this is the buffer for peaks.' },
  ];
  const ledger = ledgerTotals(state.review, 0);
  const shortages = Object.values(fc)
    .filter(({ f, s: sh }) => sh.firstShortWeek && (filters.deptId === 'all' || (f.licence.allocations[filters.deptId] ?? 0) > 0) && (filters.family === 'all' || f.licence.family === filters.family))
    .sort((a, b) => a.s.firstShortWeek!.localeCompare(b.s.firstShortWeek!));
  const upcomingPhases = ds.projects
    .filter((p) => p.status !== 'completed' && (filters.deptId === 'all' || p.deptId === filters.deptId || p.phases.some((ph) => ph.demand.some((d) => (ds.licences.find((l) => l.id === d.licenceId)?.allocations[filters.deptId] ?? 0) > 0))))
    .flatMap((p) => p.phases.filter((ph) => ph.end >= '2026-10-26' && ph.start <= '2027-04-30').map((ph) => ({ p, ph })))
    .sort((a, b) => a.ph.start.localeCompare(b.ph.start))
    .slice(0, 7);

  const exportCSV = () =>
    downloadCSV(
      `licence-overview-${filters.deptId}-${filters.months}m-sample.csv`,
      rows.map((r) => ({
        licence_id: r.licence.id,
        software: r.licence.product,
        type: r.licence.type,
        seats: r.seats,
        annual_spend_inr: Math.round(r.spend),
        utilisation_pct: (r.util * 100).toFixed(1),
        idle_checkout_hours: Math.round(r.idleHours),
        idle_spend_inr: Math.round(r.idleSpend),
        peak_concurrent: r.peak,
        denials: r.denials,
        blocked_hours: Math.round(r.blocked),
        renewal_date: r.licence.renewalDate,
      })),
    );

  return (
    <>
      <PageHead title="Licence Overview" sub="Current state, upcoming risks and recommended actions." />
      <FilterBar
        filters={filters}
        lockDept={scoped}
        onChange={(f: Partial<Filters>) => actions.setFilters(f)}
        right={
          <>
            {scoped && (
              <span className="scope-note">
                <Lock size={13} aria-hidden /> Scoped to {deptName}; other departments shown as company totals
              </span>
            )}
            <button className="btn primary" onClick={exportCSV} title="Download the software-level table as CSV (sample data)">
              <Download /> Export
            </button>
          </>
        }
      />

      <div className="kpi-grid">
        <Kpi
          label="Total Licences"
          value={num(s.seats)}
          title="Seats or seat-equivalents owned"
          onClick={() => setMetric('licences')}
          meta={
            <span>
              {s.seatsByType.floating} floating · {s.seatsByType.named} named · {s.seatsByType['node-locked'] + s.seatsByType.token} other
            </span>
          }
        />
        <Kpi
          label="Annual Spend"
          value={inrShort(s.annualSpend)}
          title="Annual licence run-rate"
          onClick={() => setMetric('spend')}
          meta={scoped ? <span>Company {inrShort(company.annualSpend)}</span> : <span>{inrShort(s.renewal90)} renews in 90 days</span>}
        />
        <Kpi
          label="Utilisation"
          value={pct(s.util)}
          title="Active licence-hours ÷ available licence-hours"
          onClick={() => setMetric('util')}
          meta={
            <>
              <DeltaPts now={s.util} prev={prev.util} goodWhen="up" />
              <span>vs previous {filters.months} months</span>
            </>
          }
        />
        <Kpi
          label="Idle Spend"
          value={inrShort(s.idleSpend)}
          title="Annual spend × (1 − utilisation)"
          onClick={() => setMetric('idle')}
          meta={<span>{pct(s.annualSpend ? s.idleSpend / s.annualSpend : 0)} of total spend</span>}
        />
        <Kpi
          label="Blocked Hours"
          value={num(s.blockedHours)}
          unit="hrs"
          title="Engineer-hours lost to licence denials"
          onClick={() => setMetric('blocked')}
          meta={
            <>
              <DeltaRel now={s.blockedHours} prev={prev.blockedHours} goodWhen="down" />
              <span>vs previous {filters.months} months</span>
            </>
          }
        />
      </div>

      <div className="grid-3">
        <Panel
          title="Spend vs Use by Department"
          sub="Annual spend, ₹ lakh · % = share in active use"
          actions={
            <div className="legend">
              <span>
                <i style={{ background: 'var(--chart-used)' }} />
                Used spend
              </span>
              <span>
                <i style={{ background: 'var(--chart-idle)' }} />
                Idle spend
              </span>
            </div>
          }
          footer={
            <span className="takeaway">
              {scoped ? (
                <>
                  <b>{deptName}</b> uses {pct(s.util)} of its {inrShort(s.annualSpend)} allocation.
                </>
              ) : (
                <>
                  <b>{biggest.name}</b> has the largest idle spend: {inrShort(biggest.idleSpend)} of {inrShort(biggest.spend)}. Click a bar to filter.
                </>
              )}
            </span>
          }
        >
          <DeptSpendBars height={scoped ? 120 : 190} rows={deptRows} selected={filters.deptId} onSelect={scoped ? undefined : (id) => actions.setFilters({ deptId: state.filters.deptId === id ? 'all' : id })} />
        </Panel>

        <Panel title="Where the spend goes" sub={`Last ${filters.months} months`} footer={<span className="takeaway">Idle check-outs are quickest to recover; unused capacity is a renewal question.</span>}>
          <SpendDonut slices={slices} centreLabel="Total Spend" centreValue={inrShort(s.annualSpend)} size={138} />
          <div className="stack" style={{ gap: 3, marginTop: 8 }}>
            {slices.map((x) => (
              <div key={x.key} className="row-between small">
                <span className="row" style={{ gap: 6 }}>
                  <i style={{ width: 9, height: 9, borderRadius: 2, background: x.color, display: 'inline-block' }} />
                  {x.label}
                </span>
                <span className="num">
                  <b style={{ fontWeight: 600 }}>{pct(s.annualSpend ? x.value / s.annualSpend : 0)}</b> <span className="muted">· {inrShort(x.value)}</span>
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <KeyActions filters={filters} />
      </div>

      <SectionLabel>Renewals and capacity risk</SectionLabel>
      <div className="grid-2-wide">
        <Panel title="Upcoming renewals" sub="Next six months · suggested quantity from usage and forecast" flush footer={<span className="takeaway">Seat reductions usually take effect only at renewal, so the date sets the earliest saving.</span>}>
          <DataTable
            rows={renewals}
            rowKey={(l) => l.id}
            onRowClick={(l) => setOpenLic(l.id)}
            empty={<div className="empty">No renewals in the next six months for this scope.</div>}
            columns={[
              { key: 'p', header: 'Software', render: (l) => <span>{l.product}<span className="sub mono">{l.contractRef}</span></span> },
              {
                key: 'd',
                header: 'Renews',
                render: (l) => {
                  const d = Math.round((Date.parse(l.renewalDate) - Date.parse('2026-10-25')) / 86400000);
                  return <StatusChip status={d <= 60 ? 'renewal-soon' : 'renewal'}>{fmtDate(l.renewalDate)} · {d} d</StatusChip>;
                },
              },
              { key: 's', header: 'Seats', num: true, render: (l) => num(filters.deptId === 'all' ? l.seats : l.allocations[filters.deptId] ?? 0) },
              { key: 'v', header: 'Annual value', num: true, render: (l) => inrShort((filters.deptId === 'all' ? l.seats : l.allocations[filters.deptId] ?? 0) * l.costPerSeat) },
              {
                key: 'a',
                header: 'Suggested',
                render: (l) => {
                  const sh = fc[l.id]?.s;
                  if (sh?.firstShortWeek) return <StatusChip status="forecast-shortage">Add capacity · peak +{Math.ceil(sh.maxGapP90 - 0.05)}</StatusChip>;
                  const a = renewalAdvice(ds, l.id);
                  return a.reduceBy > 0 ? (
                    <span className="chip teal dashed">Reduce to {a.keep} · est. {inrShort(a.annualSaving)}</span>
                  ) : (
                    <span className="chip neutral">Keep {l.seats}</span>
                  );
                },
              },
            ]}
          />
        </Panel>
        <Panel title="Forecast shortages · next 26 weeks" sub="High-demand case (P90) above owned capacity" flush footer={<span className="takeaway">Hatched = forecast, not yet happened. Open a row for the planning view.</span>}>
          {shortages.length === 0 && <div className="empty">No forecast shortages for this scope.</div>}
          {shortages.map(({ f, s: sh }) => (
            <button
              key={f.licence.id}
              className="search-hit"
              style={{ borderBottom: '1px solid var(--border)', padding: '9px 16px' }}
              onClick={() => nav(`/planning?tab=forecast&licence=${f.licence.id}`)}
            >
              <span className="grow">
                <b style={{ fontWeight: 600 }}>{f.licence.product}</b>
                <span className="small muted" style={{ display: 'block' }}>
                  {fmtDate(sh.firstShortWeek!)} – {fmtDate(sh.lastShortWeek!)} · {sh.forecastShortWeeks.length} weeks · owned {f.licence.seats}
                </span>
              </span>
              <StatusChip status="forecast-shortage">P90 +{Math.ceil(sh.maxGapP90 - 0.05)}</StatusChip>
            </button>
          ))}
        </Panel>
      </div>

      <SectionLabel>Usage patterns</SectionLabel>
      <div className="grid-3-even">
        <Panel
          title="12-month trend"
          sub="Utilisation and blocked hours by month"
          actions={
            <div className="legend">
              <span>
                <i className="line" style={{ background: 'var(--chart-used)' }} />
                Utilisation
              </span>
              <span>
                <i style={{ background: 'var(--copper-soft)' }} />
                Blocked h
              </span>
            </div>
          }
          footer={<span className="takeaway">Blocked hours fell after two ANSYS seats were re-hosted to Hadapsar in July 2026 (see Review RV-2603).</span>}
        >
          <TrendChart data={trend} />
        </Panel>
        <Panel id="unused" title="Unused named seats" sub="Days since the holder last used the seat" footer={<span className="takeaway">90+ days unused is a renewal-reduction candidate, after checking with the holder.</span>}>
          <div className="stack" style={{ gap: 10, marginTop: 4 }}>
            {unused.map((b) => (
              <div key={b.label}>
                <div className="row-between small">
                  <b style={{ fontWeight: 600 }}>{b.label}</b>
                  <span className="num">
                    {b.seats} seats{perms.seesCosts && <span className="muted"> · {inrShort(b.value)}/yr</span>}
                  </span>
                </div>
                <div style={{ marginTop: 4 }}>
                  <MiniBar value={b.seats} max={Math.max(...unused.map((x) => x.seats), 1)} />
                </div>
              </div>
            ))}
          </div>
          {perms.seesIndividuals && unused[2].holders.length > 0 && (
            <div className="small muted" style={{ marginTop: 12 }}>
              90+ days:{' '}
              {unused[2].holders
                .slice(0, 5)
                .map((h) => `${ds.users.find((u) => u.id === h.userId)?.name} (${ds.licences.find((l) => l.id === h.licenceId)?.product.replace('Autodesk ', '')}, ${h.days} d)`)
                .join(' · ')}
              {unused[2].holders.length > 5 && ` · +${unused[2].holders.length - 5} more`}
            </div>
          )}
        </Panel>
        <Panel title="Left open, not used" sub="Idle check-out hours by team · last 12 months" footer={<span className="takeaway">{teams[0] ? <><b>{teams[0].team}</b> and <b>{teams[1]?.team}</b> account for {pct((teams[0].idleHours + (teams[1]?.idleHours ?? 0)) / Math.max(1, teams.reduce((a, t) => a + t.idleHours, 0)))} of idle check-out hours shown.</> : 'No idle check-outs.'}</span>}>
          <div className="stack" style={{ gap: 8, marginTop: 4 }}>
            {teams.map((t) => (
              <div key={t.team + t.deptId}>
                <div className="row-between small">
                  <span>
                    {t.team} <span className="muted">· {ds.departments.find((d) => d.id === t.deptId)?.name}</span>
                  </span>
                  <span className="num">
                    {hours(t.idleHours)}
                    {perms.seesCosts && <span className="muted"> · {inrShort(t.idleCost)}</span>}
                  </span>
                </div>
                <div style={{ marginTop: 3 }}>
                  <MiniBar value={t.idleHours} max={teams[0]?.idleHours || 1} />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <SectionLabel>Software detail</SectionLabel>
      <Panel flush title="Software / Licence view" sub={`Last ${filters.months} months · click a row for usage, contract, holders and forecast`}>
        <DataTable
          rows={rows}
          rowKey={(r) => r.licence.id}
          onRowClick={(r) => setOpenLic(r.licence.id)}
          initialSort={{ key: 'spend', dir: 'desc' }}
          rowClass={(r) => (fc[r.licence.id]?.s.firstShortWeek ? 'flag-warn' : '')}
          columns={[
            { key: 'p', header: 'Software', render: (r) => <span>{r.licence.product}<span className="sub mono">{r.licence.id}</span></span>, sort: (r) => r.licence.product },
            { key: 't', header: 'Type', render: (r) => <span className="muted">{r.licence.type}</span>, sort: (r) => r.licence.type },
            { key: 'seats', header: 'Seats', num: true, render: (r) => num(r.seats), sort: (r) => r.seats },
            { key: 'peak', header: 'Avg / peak use', num: true, render: (r) => `${r.avgPeak.toFixed(1)} / ${r.peak}`, sort: (r) => r.peak, title: 'Average weekly peak and highest weekly peak of concurrent use' },
            { key: 'util', header: 'Utilisation', render: (r) => <span className="bar-cell" style={{ minWidth: 150 }}><MiniBar value={r.util} /> <span className="num" style={{ width: 34, textAlign: 'right' }}>{pct(r.util)}</span></span>, sort: (r) => r.util },
            { key: 'idle', header: 'Idle check-out', num: true, render: (r) => hours(r.idleHours), sort: (r) => r.idleHours },
            ...(perms.seesCosts
              ? [
                  { key: 'spend', header: 'Annual spend', num: true, render: (r: (typeof rows)[number]) => inrShort(r.spend), sort: (r: (typeof rows)[number]) => r.spend },
                  { key: 'idlesp', header: 'Idle spend', num: true, render: (r: (typeof rows)[number]) => inrShort(r.idleSpend), sort: (r: (typeof rows)[number]) => r.idleSpend },
                ]
              : []),
            { key: 'den', header: 'Denials', num: true, render: (r) => num(r.denials), sort: (r) => r.denials },
            { key: 'ren', header: 'Renews', render: (r) => <span className="nowrap">{fmtDate(r.licence.renewalDate)}</span>, sort: (r) => r.licence.renewalDate },
            {
              key: 'st',
              header: 'Status',
              render: (r) => (fc[r.licence.id]?.s.firstShortWeek ? <StatusChip status="forecast-shortage">Forecast shortage</StatusChip> : <UtilChip util={r.util} />),
            },
          ]}
          footer={
            perms.seesCosts ? (
              <tr>
                <td>Total</td>
                <td />
                <td className="num">{num(s.seats)}</td>
                <td />
                <td className="num">{pct(s.util)}</td>
                <td />
                <td className="num">{inrShort(s.annualSpend)}</td>
                <td className="num">{inrShort(s.idleSpend)}</td>
                <td className="num">{num(s.denials)}</td>
                <td colSpan={2} />
              </tr>
            ) : undefined
          }
        />
      </Panel>

      <div className="grid-3-even section-gap">
        <Panel title="Rarely used tools and add-ons" sub="2 users or fewer, or few active hours per seat" footer={<span className="takeaway">Candidates for a shared pool or token-based access.</span>} flush>
          <DataTable
            compact
            rows={rare}
            rowKey={(r) => r.licence.id}
            onRowClick={(r) => setOpenLic(r.licence.id)}
            columns={[
              { key: 'p', header: 'Tool', render: (r) => r.licence.product.replace('Autodesk ', '') },
              { key: 'u', header: 'Users', num: true, render: (r) => num(r.users) },
              { key: 'h', header: 'h / seat / month', num: true, render: (r) => r.hoursPerSeatMonth.toFixed(1) },
              ...(perms.seesCosts ? [{ key: 's', header: 'Spend', num: true, render: (r: (typeof rare)[number]) => inrShort(r.spend) }] : []),
            ]}
          />
        </Panel>
        <Panel title="Peaks and denials · ANSYS Mechanical" sub="Denied requests by weekday and hour, last 12 months" footer={<span className="takeaway">Denials cluster on <b>Tuesday–Wednesday afternoons</b>. Batch solves moved overnight would ease them.</span>}>
          <Heatmap data={heat} />
        </Panel>
        <Panel title="Project demand · next six months" sub="Phases that need licences" flush footer={<span className="takeaway">Overlapping simulation phases drive the February shortage.</span>}>
          <DataTable
            compact
            rows={upcomingPhases}
            rowKey={(r) => r.ph.id}
            onRowClick={(r) => nav(`/projects?open=${r.p.id}`)}
            columns={[
              { key: 'p', header: 'Phase', render: (r) => <span>{r.p.shortName}<span className="sub">{r.ph.name}</span></span> },
              { key: 'd', header: 'Dates', render: (r) => <span className="nowrap small">{fmtDate(r.ph.start).slice(0, 6)}–{fmtDate(r.ph.end).slice(0, 6)}</span> },
              { key: 'n', header: 'Seats', render: (r) => <span className="small">{r.ph.demand.map((d) => `${d.licenceId} ${d.seats}`).join(', ')}</span> },
            ]}
          />
        </Panel>
      </div>

      {perms.areas.includes('review') && (
        <div className="grid-2 section-gap">
          <Panel title="Savings: approved vs verified" sub="From Review & Savings — only verified savings count" footer={<button className="link-btn small" onClick={() => nav('/review')}>Open the savings ledger →</button>}>
            <table className="statement">
              <tbody>
                <tr>
                  <td>Approved savings (all cycles)</td>
                  <td className="num est">{inrShort(ledger.approved)}</td>
                </tr>
                <tr>
                  <td>Realised (contract or purchase changed)</td>
                  <td className="num est">{inrShort(ledger.realised)}</td>
                </tr>
                <tr className="total verified">
                  <td>
                    <StatusChip status="verified">Verified on invoices</StatusChip>
                  </td>
                  <td className="num">{inrShort(ledger.verified)}</td>
                </tr>
              </tbody>
            </table>
          </Panel>
          <Panel title="How these numbers are calculated" sub="Definitions used on every screen">
            <dl className="dl" style={{ gridTemplateColumns: '120px 1fr', fontSize: 12 }}>
              <dt>Utilisation</dt>
              <dd>Active licence-hours ÷ (seats × 50 working hours a week)</dd>
              <dt>Idle spend</dt>
              <dd>Annual spend × (1 − utilisation)</dd>
              <dt>Blocked hours</dt>
              <dd>Σ wait after each denial until the user got a licence</dd>
              <dt>Data</dt>
              <dd>
                Synthetic sample · {num(ds.weekly.length)} weekly records · {num(ds.monthly.length)} monthly rows
                {state.importedRows > 0 && ` · ${num(state.importedRows)} imported rows (prototype store)`}
              </dd>
            </dl>
          </Panel>
        </div>
      )}

      {metric && <MetricDrawer metric={metric} filters={filters} onClose={() => setMetric(null)} />}
      {openLic && <SoftwareDrawer licenceId={openLic} onClose={() => setOpenLic(null)} />}
    </>
  );
}

function Heatmap({ data }: { data: number[][] }) {
  const max = Math.max(1, ...data.flat());
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  return (
    <div className="heat" style={{ gridTemplateColumns: `34px repeat(${data[0].length}, 1fr)` }} role="img" aria-label="Denials by weekday and hour">
      <span />
      {data[0].map((_, h) => (
        <span key={h} style={{ textAlign: 'center' }}>
          {h % 2 === 0 ? `${8 + h}` : ''}
        </span>
      ))}
      {data.map((row, d) => (
        <div key={d} style={{ display: 'contents' }}>
          <span style={{ alignSelf: 'center' }}>{days[d]}</span>
          {row.map((v, h) => (
            <span key={h} className="heat-cell" title={`${days[d]} ${8 + h}:00 · ${v} denials`} style={{ background: v === 0 ? 'var(--surface-sunken)' : `rgba(166, 95, 46, ${0.12 + 0.78 * (v / max)})` }} />
          ))}
        </div>
      ))}
      <span />
      <span style={{ gridColumn: '2 / -1', marginTop: 4 }}>Hour of day (08:00–17:00) · darker = more denials</span>
    </div>
  );
}
