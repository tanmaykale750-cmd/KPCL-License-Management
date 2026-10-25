import { useMemo } from 'react';
import { daysToRenewal, unusedBuckets, DEFAULT_FILTERS } from '../calc/metrics';
import type { Notification } from '../domain/types';
import { fmtDate } from '../lib/dates';
import { inrShort } from '../lib/format';
import { useApp } from '../state/store';
import { canDecideRecommendation } from '../state/workflow';
import { useForecasts } from './useForecasts';

/** Alerts are fixed thresholds on measured data or the forecast (defaults from the solution). */
export function useNotifications(): { items: Notification[]; unread: number } {
  const { state, ds, perms, me } = useApp();
  const fc = useForecasts();
  return useMemo(() => {
    const out: Notification[] = [];
    const role = state.role;
    const projScope = perms.projectScope;

    for (const [id, { f, s }] of Object.entries(fc)) {
      if (!s.firstShortWeek) continue;
      const weeksAway = Math.round((Date.parse(s.firstShortWeek) - Date.parse('2026-10-25')) / (7 * 86400000));
      if (weeksAway > state.thresholds.shortageLeadWeeks) continue;
      const projects = [...new Set(f.points.filter((p) => p.p90 > p.capacity).flatMap((p) => p.projects.map((c) => c.projectId)))];
      const inScope =
        role === 'admin' ||
        (role === 'deptHead' && (f.licence.allocations[perms.deptScope ?? ''] ?? 0) > 0) ||
        (role === 'projectLead' && projects.some((p) => projScope?.includes(p)));
      if (!inScope) continue;
      out.push({
        id: `N-short-${id}`,
        at: '2026-10-25 06:00',
        kind: 'shortage',
        severity: weeksAway <= 8 ? 'crit' : 'warn',
        title: `Shortage ahead · ${f.licence.product}`,
        detail: `Forecast (P90) exceeds ${f.licence.seats} owned ${f.licence.unitLabel} from ${fmtDate(s.firstShortWeek)} for ${s.forecastShortWeeks.length} weeks.`,
        link: `/planning?tab=forecast&licence=${id}`,
        roles: ['admin', 'deptHead', 'projectLead'],
      });
    }

    if (role === 'admin') {
      for (const l of ds.licences) {
        const d = daysToRenewal(l);
        if (d >= 0 && d <= state.thresholds.renewalWindowDays)
          out.push({
            id: `N-renew-${l.id}`,
            at: '2026-10-25 06:00',
            kind: 'renewal',
            severity: d <= 60 ? 'warn' : 'info',
            title: `Renewal due in ${d} days · ${l.product}`,
            detail: `${l.seats} ${l.unitLabel} · ${inrShort(l.seats * l.costPerSeat)} a year · ${fmtDate(l.renewalDate)}`,
            link: `/software?open=${l.id}`,
            roles: ['admin'],
          });
      }
    }

    if (role === 'admin') {
      const b = unusedBuckets(ds, DEFAULT_FILTERS)[2];
      if (b.seats)
        out.push({ id: 'N-unused', at: '2026-10-25 06:00', kind: 'unused', severity: 'info', title: `${b.seats} named seats unused for 90+ days`, detail: `${inrShort(b.value)} a year paid for seats nobody has opened in three months.`, link: '/overview#unused', roles: ['admin'] });
      for (const l of ds.licences) {
        const den = ds.weekly.filter((w) => w.licenceId === l.id).slice(-4).reduce((a, w) => a + w.denials, 0);
        if (den >= state.thresholds.denialLimit)
          out.push({ id: `N-den-${l.id}`, at: '2026-10-25 06:00', kind: 'denials', severity: 'warn', title: `Denial spike · ${l.product}`, detail: `${den} denied requests in the last 4 weeks (limit ${state.thresholds.denialLimit}).`, link: `/software?open=${l.id}`, roles: ['admin'] });
      }
    }

    for (const r of state.recommendations.filter((x) => x.status === 'pending')) {
      const lic = ds.licences.find((l) => l.id === r.licenceId);
      const c = canDecideRecommendation(r, role, me.name, perms.approvalSteps, perms.deptScope, lic?.ownerDeptId ?? '');
      if (c.ok)
        out.push({ id: `N-rec-${r.id}-${r.approvals.length}`, at: r.createdAt, kind: 'approval', severity: 'warn', title: `Awaiting your decision · ${r.id}`, detail: r.title, link: `/registry?tab=approvals&open=${r.id}`, roles: [role] });
    }

    if (perms.approveRequests) {
      for (const r of state.requests.filter((x) => x.status === 'submitted')) {
        const u = ds.users.find((x) => x.id === r.requesterId);
        if (u?.deptId !== perms.deptScope) continue;
        out.push({ id: `N-req-${r.id}`, at: r.submittedAt, kind: 'request', severity: r.urgency === 'blocking' ? 'warn' : 'info', title: `Access request ${r.id} to review`, detail: `${u?.name ?? ''} · ${ds.licences.find((l) => l.id === r.licenceId)?.product}`, link: `/access-requests?open=${r.id}`, roles: ['deptHead'] });
      }
    }
    if (perms.fulfilRequests) {
      for (const r of state.requests.filter((x) => x.status === 'approved'))
        out.push({ id: `N-ful-${r.id}`, at: r.submittedAt, kind: 'request', severity: 'info', title: `Fulfil approved request ${r.id}`, detail: ds.licences.find((l) => l.id === r.licenceId)?.product ?? '', link: `/access-requests?open=${r.id}`, roles: ['admin'] });
      for (const r of state.review.filter((x) => x.state === 'awaiting-implementation'))
        out.push({ id: `N-impl-${r.id}`, at: r.approvedAt, kind: 'review', severity: 'info', title: `Implement approved action ${r.id}`, detail: r.title, link: `/review?open=${r.id}`, roles: ['admin'] });
    }
    if (role === 'engineer') {
      for (const r of state.requests.filter((x) => x.requesterId === me.id && x.status !== 'submitted'))
        out.push({ id: `N-mine-${r.id}-${r.status}`, at: r.history[r.history.length - 1].at, kind: 'request', severity: r.status === 'rejected' ? 'warn' : 'info', title: `${r.id} ${r.status === 'more-info' ? 'needs more information' : r.status}`, detail: r.decisionReason ?? r.fulfilment ?? '', link: `/access-requests?open=${r.id}`, roles: ['engineer'] });
    }
    if (perms.verifySavings) {
      for (const r of state.review.filter((x) => x.state === 'awaiting-invoice'))
        out.push({ id: `N-ver-${r.id}`, at: r.approvedAt, kind: 'review', severity: 'info', title: `Verify savings · ${r.id}`, detail: `${r.title} — invoice evidence needed`, link: `/review?open=${r.id}`, roles: ['admin'] });
    }
    for (const c of state.projectChanges) {
      if ((c.status === 'pending-dept' && perms.approveProjectChanges) || (c.status === 'pending-admin' && perms.confirmProjectChanges))
        out.push({ id: `N-pc-${c.id}-${c.status}`, at: c.proposedAt, kind: 'approval', severity: 'info', title: `Project change ${c.id} to ${c.status === 'pending-dept' ? 'approve' : 'confirm'}`, detail: `${c.before} → ${c.after}`, link: `/projects?change=${c.id}`, roles: [role] });
    }

    const unread = out.filter((n) => !state.readNotifications.includes(n.id)).length;
    return { items: out, unread };
  }, [state, ds, perms, me, fc]);
}
