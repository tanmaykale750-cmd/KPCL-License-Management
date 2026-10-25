import { useMemo } from 'react';
import { forecast, shortageSummary } from '../../calc/forecast';
import { DataTable } from '../../components/ui/DataTable';
import { Callout, Panel } from '../../components/ui/basics';
import { StatusChip } from '../../components/ui/StatusChip';
import { fmtDate } from '../../lib/dates';
import { hours, inrShort } from '../../lib/format';
import { useApp } from '../../state/store';

function Spark({ pts, cap }: { pts: { p50: number; p90: number }[]; cap: number }) {
  const w = 120;
  const h = 34;
  const max = Math.max(cap, ...pts.map((p) => p.p90)) * 1.08;
  const x = (i: number) => (i / Math.max(1, pts.length - 1)) * w;
  const y = (v: number) => h - (v / max) * h;
  const band = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.p90)}`).join('') + [...pts].reverse().map((p, i) => `L${x(pts.length - 1 - i)},${y(p.p50)}`).join('') + 'Z';
  return (
    <svg width={w} height={h} aria-hidden style={{ display: 'block' }}>
      {pts.map((p, i) => (p.p90 > cap ? <rect key={i} x={x(i) - w / pts.length / 2} y={0} width={w / pts.length} height={h} fill="rgba(154,91,0,0.14)" /> : null))}
      <path d={band} fill="var(--chart-band)" />
      <path d={pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.p50)}`).join('')} fill="none" stroke="var(--chart-p50)" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1={0} x2={w} y1={y(cap)} y2={y(cap)} stroke="var(--chart-capacity)" strokeWidth="1.5" />
    </svg>
  );
}

export function SupplyTab({ horizon, onOpen }: { horizon: number; onOpen: (licenceId: string) => void }) {
  const { ds, state, perms } = useApp();
  const fin = state.finance[0];
  const rows = useMemo(
    () =>
      ds.licences
        .filter((l) => l.forecastable && (!perms.deptScope || (l.allocations[perms.deptScope] ?? 0) > 0))
        .map((l) => {
          const f = forecast(ds, l.id, { horizonWeeks: horizon });
          const s = shortageSummary(f);
          const peak50 = Math.max(...f.points.map((p) => p.p50));
          const peak90 = Math.max(...f.points.map((p) => p.p90));
          const surplusWeeks = f.points.filter((p) => p.p90 < p.capacity - 1).length;
          return { l, f, s, peak50, peak90, surplusWeeks };
        }),
    [ds, horizon, perms.deptScope],
  );
  return (
    <div className="stack-lg">
      <Callout>
        Usable supply respects licence rules: <b>named seats cannot be shared</b>; floating seats are shared only within their pool and server; an <b>add-on</b> (HPC Pack) cannot exceed its base product; <b>node-locked</b> seats stay on licensed workstations; token pools are shown in seat-equivalents.
      </Callout>
      <Panel flush title="Demand versus supply by pool" sub={`High-demand case (P90) against owned capacity over the next ${horizon} weeks · click a row for the forecast`}>
        <DataTable
          rows={rows}
          rowKey={(r) => r.l.id}
          onRowClick={(r) => onOpen(r.l.id)}
          initialSort={{ key: 'gap', dir: 'desc' }}
          rowClass={(r) => (r.s.forecastShortWeeks.length ? 'flag-warn' : '')}
          columns={[
            { key: 'p', header: 'Pool', render: (r) => <span>{r.l.product}<span className="sub mono">{r.l.id} · {r.l.type}</span></span>, sort: (r) => r.l.product },
            { key: 'o', header: 'Owned', num: true, render: (r) => r.l.seats, sort: (r) => r.l.seats },
            { key: 'p50', header: 'Peak P50', num: true, render: (r) => r.peak50.toFixed(1), sort: (r) => r.peak50 },
            { key: 'p90', header: 'Peak P90', num: true, render: (r) => r.peak90.toFixed(1), sort: (r) => r.peak90 },
            { key: 'gap', header: 'Gap at P90', num: true, render: (r) => (r.s.maxGapP90 > 0.05 ? <span className="text-warn">+{r.s.maxGapP90.toFixed(1)}</span> : <span className="muted">—</span>), sort: (r) => r.s.maxGapP90 },
            { key: 'sw', header: 'Shortage weeks', render: (r) => (r.s.forecastShortWeeks.length ? <StatusChip status="forecast-shortage">{r.s.forecastShortWeeks.length} wk · from {fmtDate(r.s.firstShortWeek!).slice(0, 6)}</StatusChip> : <StatusChip status="healthy">Covered</StatusChip>), sort: (r) => r.s.forecastShortWeeks.length },
            { key: 'su', header: 'Surplus weeks', num: true, render: (r) => r.surplusWeeks, sort: (r) => r.surplusWeeks, title: 'Weeks when P90 is more than one seat below capacity' },
            { key: 'bh', header: 'Expected blocked', num: true, render: (r) => (r.s.blockedHours < 0.5 ? <span className="muted">—</span> : hours(r.s.blockedHours)), sort: (r) => r.s.blockedHours },
            ...(perms.seesCosts ? [{ key: 'bc', header: 'Cost of blocked time', num: true, render: (r: (typeof rows)[number]) => (r.s.blockedHours < 0.5 ? <span className="muted">—</span> : inrShort(r.s.blockedHours * fin.loadedHourlyCost * fin.productivityLoss)), sort: (r: (typeof rows)[number]) => r.s.blockedHours }] : []),
            { key: 'sp', header: `Next ${horizon} weeks`, render: (r) => <Spark pts={r.f.points} cap={r.l.seats} /> },
          ]}
        />
      </Panel>
      <p className="small muted">
        Expected blocked hours = Σ expected seats short per week × blocked hours per seat-week measured from past denials. Cost uses finance’s rate ₹{fin.loadedHourlyCost}/h × loss factor {fin.productivityLoss} ({fin.version}).
      </p>
    </div>
  );
}
