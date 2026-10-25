import { ArrowRight, Download, Pencil } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { forecast, shortageSummary } from '../../calc/forecast';
import { daysToRenewal, idleCheckoutShare, licenceSpend, periodMonths, totals, utilisation } from '../../calc/metrics';
import { renewalAdvice } from '../../calc/plan';
import { DEMO_TODAY, daysBetween, fmtDate } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';
import { hours, inr, inrShort, num, pct } from '../../lib/format';
import { useApp } from '../../state/store';
import { DataTable } from '../ui/DataTable';
import { Drawer } from '../ui/Overlay';
import { StatusChip, UtilChip } from '../ui/StatusChip';
import { Callout } from '../ui/basics';

const TYPE_LABEL = { floating: 'Floating (shared pool)', named: 'Named user', 'node-locked': 'Node-locked', token: 'Token / unit-based' } as const;

export function SoftwareDrawer({ licenceId, onClose, onEdit }: { licenceId: string; onClose: () => void; onEdit?: () => void }) {
  const { ds, perms, state } = useApp();
  const nav = useNavigate();
  const lic = ds.licences.find((l) => l.id === licenceId)!;
  const vendor = ds.vendors.find((v) => v.id === lic.vendorId);
  const months = periodMonths(12);
  const t = totals(ds.monthly.filter((r) => r.licenceId === lic.id && months.includes(r.month)));
  const util = utilisation(t);
  const spend = licenceSpend(lic);
  const weekly = ds.weekly.filter((w) => w.licenceId === lic.id).slice(-26);
  const fc = useMemo(() => (lic.forecastable ? forecast(ds, lic.id, { horizonWeeks: 12 }) : null), [ds, lic]);
  const short = fc ? shortageSummary(fc) : null;
  const advice = useMemo(() => renewalAdvice(ds, lic.id), [ds, lic.id]);
  const chart = [
    ...weekly.map((w) => ({ week: w.weekStart, actual: w.demand, cap: w.capacity, p50: undefined as number | undefined, p90: undefined as number | undefined })),
    ...(fc?.points.map((p) => ({ week: p.week, actual: undefined, cap: p.capacity, p50: Math.round(p.p50 * 10) / 10, p90: Math.round(p.p90 * 10) / 10 })) ?? []),
  ];
  // department heads see only their own department's people (privacy rule); administrators see everyone
  const inScope = (userId: string) => !perms.deptScope || ds.users.find((u) => u.id === userId)?.deptId === perms.deptScope;
  const holders = ds.assignments.filter((a) => a.licenceId === lic.id && inScope(a.userId));
  const userRows = ds.userUsage.filter((u) => u.licenceId === lic.id && inScope(u.userId)).sort((a, b) => b.activeHours12m - a.activeHours12m);
  const projects = ds.projects.filter((p) => p.status !== 'completed' && p.phases.some((ph) => ph.demand.some((d) => d.licenceId === lic.id)));
  const recs = state.recommendations.filter((r) => r.licenceId === lic.id);
  const d2r = daysToRenewal(lic);

  return (
    <Drawer
      wide
      eyebrow={`${lic.id} · ${lic.feature}`}
      title={lic.product}
      onClose={onClose}
      aside={
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <UtilChip util={util} />
          {d2r <= 90 && <StatusChip status={d2r <= 30 ? 'renewal-soon' : 'renewal'}>Renews in {d2r} days</StatusChip>}
          {short?.firstShortWeek && <StatusChip status="forecast-shortage">Forecast shortage · from {fmtDate(short.firstShortWeek)}</StatusChip>}
          {lic.baseLicenceId && <span className="chip neutral">Add-on to {lic.baseLicenceId}</span>}
        </div>
      }
      footer={
        <>
          {onEdit && (
            <button className="btn" onClick={onEdit} style={{ marginRight: 'auto' }}>
              <Pencil /> Edit record
            </button>
          )}
          {perms.seesCosts && (
            <button
              className="btn"
              onClick={() =>
                downloadCSV(`${lic.id}-usage-sample.csv`, weekly.map((w) => ({ licence: lic.id, week_start: w.weekStart, peak_demand: w.demand, observed_peak: w.observedPeak, capacity: w.capacity, denials: w.denials, blocked_hours: w.blockedHours })))
              }
            >
              <Download /> Export weekly usage
            </button>
          )}
          {lic.forecastable && perms.areas.includes('planning') && (
            <button className="btn primary" onClick={() => nav(`/planning?tab=forecast&licence=${lic.id}`)}>
              Open in Planning Studio <ArrowRight />
            </button>
          )}
        </>
      }
    >
      <dl className="dl">
        <dt>Licence type</dt>
        <dd>{TYPE_LABEL[lic.type]} — not interchangeable with other types</dd>
        <dt>Capacity</dt>
        <dd>
          {num(lic.seats)} {lic.unitLabel} · server <span className="mono">{lic.server}</span>
        </dd>
        <dt>Allocation</dt>
        <dd>
          {Object.entries(lic.allocations)
            .map(([d, n]) => `${ds.departments.find((x) => x.id === d)?.name} ${n}`)
            .join(' · ')}
        </dd>
        {perms.seesCosts && (
          <>
            <dt>Cost</dt>
            <dd>
              <span className="num">{inr(lic.costPerSeat)}</span> per {lic.unitLabel.replace(/s$/, '')} a year · <b className="num">{inrShort(spend)}</b> total
            </dd>
            <dt>Contract / PO</dt>
            <dd>
              <span className="mono">{lic.contractRef}</span> · <span className="mono">{lic.poRef}</span> · {vendor?.name}
            </dd>
          </>
        )}
        <dt>Term</dt>
        <dd>
          {fmtDate(lic.startDate, 'long')} → renews {fmtDate(lic.renewalDate, 'long')} ({d2r} days, notice {lic.noticeDays} days, contract minimum {lic.contractMinSeats})
        </dd>
      </dl>

      <div className="block">
        <h3>Usage, last 12 months (working-hours basis)</h3>
        <div className="kv-strip">
          <span>
            Utilisation <b>{pct(util)}</b>
          </span>
          <span>
            Idle check-outs <b>{pct(idleCheckoutShare(t))}</b> ({hours(t.idleCheckout)})
          </span>
          {perms.seesCosts && (
            <span>
              Idle spend <b>{inrShort(spend * (1 - util))}</b>
            </span>
          )}
          <span>
            Denials <b>{num(t.denials)}</b>
          </span>
          <span>
            Blocked <b>{hours(t.blocked)}</b>
          </span>
        </div>
      </div>

      <div className="block">
        <h3>{fc ? 'Weekly peak demand · last 26 weeks and 12-week forecast' : 'Weekly active holders · last 26 weeks'}</h3>
        <div className="legend" style={{ marginBottom: 6 }}>
          <span>
            <i className="line" style={{ background: 'var(--chart-actual)' }} />
            Actual peak
          </span>
          {fc && (
            <>
              <span>
                <i className="dashed" />
                P50 forecast
              </span>
              <span>
                <i className="line" style={{ background: 'var(--teal-soft)' }} />
                P90
              </span>
            </>
          )}
          <span>
            <i className="line" style={{ background: 'var(--copper)' }} />
            Owned capacity
          </span>
        </div>
        <ResponsiveContainer width="100%" height={170}>
          <LineChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <XAxis dataKey="week" tickFormatter={(w: string) => fmtDate(w).slice(3)} tick={{ fontSize: 10.5, fill: 'var(--chart-axis)' }} interval={5} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
            <YAxis tick={{ fontSize: 10.5, fill: 'var(--chart-axis)' }} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip formatter={(v: number, n: string) => [v, n === 'actual' ? 'Actual peak' : n === 'cap' ? 'Owned' : n.toUpperCase()]} labelFormatter={(w: string) => `Week of ${fmtDate(w)}`} />
            <ReferenceLine x={chart[weekly.length]?.week} stroke="var(--border-strong)" strokeDasharray="2 3" />
            <Line dataKey="cap" type="stepAfter" stroke="var(--copper)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line dataKey="actual" stroke="var(--chart-actual)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="p90" stroke="var(--teal-soft)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="p50" stroke="var(--chart-p50)" strokeDasharray="5 4" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {perms.seesCosts && (
        <div className="block">
          <h3>Renewal view</h3>
          {advice.reduceBy > 0 ? (
            <Callout tone="teal">
              <b>Suggested at renewal:</b> keep {advice.keep} of {lic.seats} {lic.unitLabel}, saving <b>{inrShort(advice.annualSaving)}</b> a year. {advice.reason}
            </Callout>
          ) : short?.firstShortWeek ? (
            <Callout tone="warn">
              <b>Do not reduce:</b> the forecast exceeds owned capacity for {short.forecastShortWeeks.length} weeks from {fmtDate(short.firstShortWeek)}. Compare options in the Planning Studio.
            </Callout>
          ) : (
            <Callout>
              <b>Keep current quantity.</b> {advice.reason}
            </Callout>
          )}
          {recs.length > 0 && (
            <div className="small" style={{ marginTop: 8 }}>
              Related recommendations:{' '}
              {recs.map((r) => (
                <button key={r.id} className="code-ref" style={{ marginRight: 8 }} onClick={() => nav(`/registry?tab=approvals&open=${r.id}`)}>
                  {r.id} ({r.status})
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {projects.length > 0 && (
        <div className="block">
          <h3>Projects that need it</h3>
          {projects.map((p) => (
            <div key={p.id} className="row-between small" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <span>
                <b>{p.shortName}</b> <span className="muted">{p.code}</span> {p.critical && <StatusChip status="critical-project">Critical</StatusChip>}
              </span>
              <span className="muted">
                {p.phases
                  .filter((ph) => ph.demand.some((d) => d.licenceId === lic.id))
                  .map((ph) => `${ph.name}: ${ph.demand.find((d) => d.licenceId === lic.id)!.seats} seats, ${fmtDate(ph.start)}–${fmtDate(ph.end)}`)
                  .join(' · ')}
              </span>
            </div>
          ))}
        </div>
      )}

      {perms.seesIndividuals && (
        <div className="block">
          <h3>{lic.type === 'named' ? `Named holders (${holders.length})` : `Users (${userRows.length})`}{perms.deptScope ? ' · your department' : ''}</h3>
          <DataTable
            compact
            pageSize={10}
            rows={userRows}
            rowKey={(r) => r.userId}
            initialSort={{ key: 'last', dir: 'desc' }}
            columns={[
              { key: 'name', header: 'User', render: (r) => { const u = ds.users.find((x) => x.id === r.userId)!; return <span>{u.name} <span className="sub">{u.team}</span></span>; }, sort: (r) => ds.users.find((x) => x.id === r.userId)!.name },
              { key: 'active', header: 'Active h (12m)', num: true, render: (r) => num(r.activeHours12m), sort: (r) => r.activeHours12m },
              { key: 'idle', header: 'Idle check-out h', num: true, render: (r) => num(r.idleHours12m), sort: (r) => r.idleHours12m },
              { key: 'den', header: 'Denials', num: true, render: (r) => num(r.denials12m), sort: (r) => r.denials12m },
              {
                key: 'last',
                header: 'Last used',
                render: (r) => {
                  const d = daysBetween(r.lastActive, DEMO_TODAY);
                  return d >= 90 ? <StatusChip status="unverified">{d} days ago</StatusChip> : <span>{fmtDate(r.lastActive)}</span>;
                },
                sort: (r) => -daysBetween(r.lastActive, DEMO_TODAY),
              },
            ]}
          />
        </div>
      )}
      {!perms.seesIndividuals && (
        <p className="small muted block">Individual usage is visible only to administrators, and to department heads for their own department (privacy rule).</p>
      )}
    </Drawer>
  );
}
