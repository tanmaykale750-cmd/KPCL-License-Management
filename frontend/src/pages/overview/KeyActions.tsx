import { CalendarClock, ChevronRight, OctagonAlert, ReceiptText, Users, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { daysToRenewal, nextRenewals, unusedBuckets, type Filters } from '../../calc/metrics';
import { renewalAdvice } from '../../calc/plan';
import { verifiedSaving } from '../../calc/review';
import { useForecasts } from '../../hooks/useForecasts';
import { fmtDate, monthLabel } from '../../lib/dates';
import { inrShort } from '../../lib/format';
import { useApp } from '../../state/store';

interface Action {
  id: string;
  rank: number;
  tone: 'crit' | 'warn' | 'copper' | 'ok';
  icon: LucideIcon;
  title: string;
  detail: string;
  tag: string;
  to: string;
}

const TONE: Record<Action['tone'], { bg: string; fg: string }> = {
  crit: { bg: 'rgba(214, 84, 76, 0.18)', fg: '#f19a93' },
  warn: { bg: 'rgba(222, 160, 70, 0.18)', fg: '#e9b56b' },
  copper: { bg: 'rgba(197, 138, 92, 0.2)', fg: '#e0a777' },
  ok: { bg: 'rgba(95, 181, 140, 0.18)', fg: '#8fd0b0' },
};

export function useKeyActions(filters: Filters): Action[] {
  const { ds, state, perms } = useApp();
  const fc = useForecasts();
  return useMemo(() => {
    const out: Action[] = [];
    // Forecast shortages (most urgent first), scoped to the filtered department.
    const shortages = Object.values(fc)
      .filter(({ f, s }) => s.firstShortWeek && (filters.deptId === 'all' || (f.licence.allocations[filters.deptId] ?? 0) > 0))
      .sort((a, b) => a.s.firstShortWeek!.localeCompare(b.s.firstShortWeek!) || b.s.maxGapP90 - a.s.maxGapP90);
    // Severity: seats short at peak, doubled when a critical project is affected.
    const hitsCritical = (x: (typeof shortages)[number]) => x.f.points.some((p) => p.p90 > p.capacity && p.projects.some((c) => ds.projects.find((y) => y.id === c.projectId)?.critical));
    const top = [...shortages].sort((a, b) => b.s.maxGapP90 * (hitsCritical(b) ? 2 : 1) - a.s.maxGapP90 * (hitsCritical(a) ? 2 : 1))[0];
    const critical = top && hitsCritical(top);
    if (top) {
      const gapLo = Math.max(1, Math.round(top.s.maxGapP50));
      const gapHi = Math.ceil(top.s.maxGapP90 - 0.05);
      out.push({
        id: `short-${top.f.licence.id}`,
        rank: 1,
        tone: 'crit',
        icon: OctagonAlert,
        title: `${top.f.licence.product.replace(' Enterprise', '').replace(' units', '')} shortage · ${monthLabel(top.s.firstShortWeek!.slice(0, 7))}–${monthLabel(top.s.lastShortWeek!.slice(0, 7), true)}`,
        detail: `${gapLo === gapHi ? gapHi : `${gapLo}–${gapHi}`} ${top.f.licence.unitLabel} short at peak${critical ? ' · critical project affected' : ''}`,
        tag: 'Forecast',
        to: `/planning?tab=forecast&licence=${top.f.licence.id}`,
      });
    }
    // Underutilised named seats with a renewal coming up.
    const unused = unusedBuckets(ds, filters)[2];
    if (unused.seats > 0 && perms.seesCosts) {
      const byLic = new Map<string, number>();
      unused.holders.forEach((h) => byLic.set(h.licenceId, (byLic.get(h.licenceId) ?? 0) + 1));
      const [licId, n] = [...byLic.entries()].sort((a, b) => b[1] - a[1])[0];
      const lic = ds.licences.find((l) => l.id === licId)!;
      const adv = renewalAdvice(ds, licId);
      const rec = state.recommendations.find((r) => r.licenceId === licId && r.status === 'pending');
      out.push({
        id: `unused-${licId}`,
        rank: 2,
        tone: 'warn',
        icon: Users,
        title: `${n} ${lic.product.replace('Autodesk ', '').replace(' Professional', '')} seats unused 90+ days`,
        detail: `Potential ${inrShort(adv.annualSaving)} a year at renewal on ${fmtDate(lic.renewalDate)}`,
        tag: 'Estimate',
        to: rec ? `/registry?tab=approvals&open=${rec.id}` : `/software?open=${licId}`,
      });
    }
    // Renewals in the next 90 days.
    const ren = nextRenewals(ds, filters, 90);
    if (ren.length && perms.seesCosts) {
      const value = ren.reduce((s, l) => s + (filters.deptId === 'all' ? l.seats : l.allocations[filters.deptId] ?? 0) * l.costPerSeat, 0);
      out.push({
        id: 'renewals',
        rank: 3,
        tone: 'copper',
        icon: CalendarClock,
        title: `${ren.length} renewal${ren.length > 1 ? 's' : ''} in the next 90 days`,
        detail: `${inrShort(value)} · first in ${daysToRenewal(ren[0])} days (${ren[0].product.replace('Autodesk ', '').split(' ')[0]})`,
        tag: 'Due',
        to: '/software?view=renewals',
      });
    }
    // Savings awaiting verification.
    const awaiting = state.review.filter((r) => r.state === 'awaiting-invoice' || r.state === 'awaiting-implementation' || r.state === 'partly-verified');
    if (awaiting.length && perms.areas.includes('review')) {
      const est = awaiting.reduce((s, r) => s + r.approvedValue - verifiedSaving(r), 0);
      out.push({
        id: 'verify',
        rank: 4,
        tone: 'ok',
        icon: ReceiptText,
        title: `Verify savings · ${awaiting.length} approved decision${awaiting.length > 1 ? 's' : ''}`,
        detail: `est. ${inrShort(est)} not yet on an invoice`,
        tag: 'Review',
        to: '/review',
      });
    }
    return out;
  }, [fc, ds, state, filters, perms]);
}

export function KeyActions({ filters }: { filters: Filters }) {
  const actions = useKeyActions(filters);
  const nav = useNavigate();
  return (
    <section className="panel panel-dark" aria-labelledby="key-actions-h">
      <div className="panel-head" style={{ paddingBottom: 6 }}>
        <div>
          <h2 id="key-actions-h">Key Actions</h2>
          <div className="sub">Ranked by urgency, then ₹ impact</div>
        </div>
      </div>
      <div style={{ padding: '0 8px 8px' }}>
        {actions.length === 0 && <div className="empty" style={{ color: 'var(--ink-text-2)' }}>No actions for this scope.</div>}
        {actions.map((a) => {
          const t = TONE[a.tone];
          return (
            <button
              key={a.id}
              onClick={() => nav(a.to)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                padding: '10px 8px',
                border: 0,
                borderTop: '1px solid var(--ink-rule)',
                background: 'transparent',
                color: 'var(--ink-text)',
                textAlign: 'left',
                borderRadius: 0,
              }}
              className="ink-row"
            >
              <span style={{ width: 30, height: 30, borderRadius: 4, background: t.bg, color: t.fg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                <a.icon size={16} aria-hidden strokeWidth={1.8} />
              </span>
              <span className="grow">
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{a.title}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-text-2)', marginTop: 2 }}>{a.detail}</span>
              </span>
              <span style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-text-2)', border: '1px dashed var(--ink-rule)', padding: '2px 5px', borderRadius: 3 }}>{a.tag}</span>
              <ChevronRight size={16} aria-hidden style={{ color: 'var(--ink-text-2)', flex: 'none' }} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
