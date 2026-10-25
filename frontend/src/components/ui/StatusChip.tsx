import {
  BadgeCheck,
  Ban,
  CalendarClock,
  Check,
  CheckCheck,
  CircleCheck,
  CircleDashed,
  CircleX,
  Flag,
  Gauge,
  Hourglass,
  Info,
  OctagonAlert,
  Send,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

export type Status =
  | 'healthy'
  | 'underused'
  | 'forecast-shortage'
  | 'shortage'
  | 'critical-project'
  | 'renewal'
  | 'renewal-soon'
  | 'pending'
  | 'approved'
  | 'implemented'
  | 'verified'
  | 'unverified'
  | 'rejected'
  | 'submitted'
  | 'info'
  | 'cancelled'
  | 'not-implemented';

const MAP: Record<Status, { cls: string; icon: LucideIcon }> = {
  healthy: { cls: 'chip ok', icon: CircleCheck },
  underused: { cls: 'chip info', icon: Gauge },
  'forecast-shortage': { cls: 'chip warn hatched', icon: TriangleAlert },
  shortage: { cls: 'chip solid crit', icon: OctagonAlert },
  'critical-project': { cls: 'chip solid crit', icon: Flag },
  renewal: { cls: 'chip neutral', icon: CalendarClock },
  'renewal-soon': { cls: 'chip warn', icon: CalendarClock },
  pending: { cls: 'chip neutral', icon: Hourglass },
  submitted: { cls: 'chip info', icon: Send },
  approved: { cls: 'chip teal', icon: Check },
  implemented: { cls: 'chip solid teal', icon: CheckCheck },
  verified: { cls: 'chip solid ok', icon: BadgeCheck },
  unverified: { cls: 'chip neutral dashed', icon: CircleDashed },
  rejected: { cls: 'chip crit', icon: CircleX },
  'not-implemented': { cls: 'chip warn', icon: Ban },
  cancelled: { cls: 'chip neutral', icon: Ban },
  info: { cls: 'chip info', icon: Info },
};

export function StatusChip({ status, children, title }: { status: Status; children: ReactNode; title?: string }) {
  const m = MAP[status];
  const Icon = m.icon;
  return (
    <span className={m.cls} title={title}>
      <Icon aria-hidden />
      {children}
    </span>
  );
}

/** Utilisation band: ≥75% healthy, 50–75% amber, <50% underused (thresholds from the solution). */
export function UtilChip({ util }: { util: number }) {
  const p = `${Math.round(util * 100)}%`;
  if (util >= 0.75) return <StatusChip status="healthy">Healthy · {p}</StatusChip>;
  if (util >= 0.5)
    return (
      <span className="chip warn">
        <Gauge aria-hidden />
        Moderate · {p}
      </span>
    );
  return <StatusChip status="underused">Underused · {p}</StatusChip>;
}
