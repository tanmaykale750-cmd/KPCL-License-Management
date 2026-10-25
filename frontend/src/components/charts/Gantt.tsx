import { Flag } from 'lucide-react';
import type { Project, ProjectPhase } from '../../domain/types';
import { addDays, daysBetween, fmtDate, monthLabel, toDate } from '../../lib/dates';

export const PHASE_COLOR: Record<ProjectPhase['kind'], string> = {
  concept: '#9aa6a5',
  'detailed-design': '#5f8f8c',
  simulation: '#0e6b68',
  validation: '#2f7f97',
  release: '#a65f2e',
};

export interface TimeScale {
  start: string;
  end: string;
  left: number;
  width: number;
  x: (d: string) => number;
}

export function makeScale(start: string, end: string, left: number, width: number): TimeScale {
  const total = Math.max(1, daysBetween(start, end));
  return { start, end, left, width, x: (d: string) => left + (Math.max(0, Math.min(total, daysBetween(start, d))) / total) * width };
}

/** Axis label: month abbreviation, with the year shown in place of January. */
export function tickLabel(t: string): string {
  return t.slice(5, 7) === '01' ? t.slice(0, 4) : monthLabel(t.slice(0, 7));
}

export function monthTicks(start: string, end: string): string[] {
  const out: string[] = [];
  const s = toDate(start);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth() + (s.getUTCDate() > 1 ? 1 : 0);
  for (;;) {
    if (m > 11) {
      y++;
      m = 0;
    }
    const d = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    if (d > end) break;
    out.push(d);
    m++;
  }
  return out;
}

export function Gantt({
  projects,
  scale,
  today,
  onSelect,
  selectedId,
  highlightLicence,
  todayLabel = true,
  rowHeight = 30,
  hideCosts,
  shortWeeksFor,
}: {
  projects: Project[];
  scale: TimeScale;
  today: string;
  onSelect?: (p: Project) => void;
  selectedId?: string;
  highlightLicence?: string;
  todayLabel?: boolean;
  rowHeight?: number;
  hideCosts?: boolean;
  shortWeeksFor?: (p: Project, ph: ProjectPhase) => string[];
}) {
  const ticks = monthTicks(scale.start, scale.end);
  const height = 26 + projects.length * rowHeight + 4;
  void hideCosts;
  return (
    <div style={{ position: 'relative', height }} role="img" aria-label="Project phases on a shared timeline">
      {/* month grid */}
      {ticks.map((t) => (
        <div key={t} style={{ position: 'absolute', left: scale.x(t), top: 0, bottom: 0, borderLeft: '1px solid var(--chart-grid)' }}>
          <span className="mono" style={{ position: 'absolute', top: 4, left: 4, fontSize: 10.5, color: 'var(--chart-axis)', whiteSpace: 'nowrap' }}>
            {tickLabel(t)}
          </span>
        </div>
      ))}
      {today >= scale.start && today <= scale.end && (
        <div style={{ position: 'absolute', left: scale.x(today), top: 18, bottom: 0, borderLeft: '1.5px dashed var(--copper)' }}>
          {todayLabel && <span style={{ position: 'absolute', top: -16, left: -14, fontSize: 10, color: 'var(--copper)', fontWeight: 600, background: 'var(--panel)', padding: '0 2px' }}>Today</span>}
        </div>
      )}
      {projects.map((p, i) => {
        const y = 26 + i * rowHeight;
        const selected = selectedId === p.id;
        return (
          <div key={p.id} style={{ position: 'absolute', left: 0, right: 0, top: y, height: rowHeight - 2 }}>
            <button
              onClick={() => onSelect?.(p)}
              style={{
                position: 'absolute',
                left: 0,
                width: scale.left - 10,
                top: 0,
                height: rowHeight - 4,
                border: 0,
                background: selected ? 'var(--row-selected)' : 'transparent',
                borderRadius: 3,
                textAlign: 'left',
                padding: '0 6px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                cursor: onSelect ? 'pointer' : 'default',
              }}
              title={`${p.code} · ${p.name}`}
            >
              {p.critical && <Flag size={12} color="var(--crit)" aria-label="Critical project" />}
              <span className="ellipsis" style={{ fontWeight: 600 }}>
                {p.shortName}
              </span>
              <span className="muted ellipsis" style={{ fontSize: 11 }}>
                {p.dateStatus === 'tentative' ? `tentative ${Math.round(p.confidence * 100)}%` : p.code}
              </span>
            </button>
            {p.phases.map((ph) => {
              if (ph.end < scale.start || ph.start > scale.end) return null;
              const x1 = scale.x(ph.start < scale.start ? scale.start : ph.start);
              const x2 = scale.x(ph.end > scale.end ? scale.end : addDays(ph.end, 1));
              const relevant = !highlightLicence || ph.demand.some((d) => d.licenceId === highlightLicence);
              const short = shortWeeksFor?.(p, ph) ?? [];
              const seats = highlightLicence ? ph.demand.find((d) => d.licenceId === highlightLicence)?.seats : undefined;
              return (
                <div
                  key={ph.id}
                  title={`${p.shortName} · ${ph.name}\n${fmtDate(ph.start)} – ${fmtDate(ph.end)}\n${ph.demand.map((d) => `${d.licenceId}: ${Math.round(d.seats * 10) / 10} seats`).join('\n')}${short.length ? `\nForecast shortage in ${short.length} week(s)` : ''}`}
                  style={{
                    position: 'absolute',
                    left: x1,
                    width: Math.max(4, x2 - x1 - 1),
                    top: 4,
                    height: rowHeight - 12,
                    borderRadius: 2,
                    background: !relevant ? 'var(--surface-sunken)' : p.dateStatus === 'tentative' ? 'transparent' : PHASE_COLOR[ph.kind],
                    border: `1.5px ${p.dateStatus === 'tentative' ? 'dashed' : 'solid'} ${relevant ? PHASE_COLOR[ph.kind] : 'var(--border)'}`,
                    color: !relevant ? 'var(--text-3)' : p.dateStatus === 'tentative' ? PHASE_COLOR[ph.kind] : '#fff',
                    fontWeight: relevant ? 600 : 500,
                    fontSize: 10.5,
                    padding: '0 5px',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    alignItems: 'center',
                    boxShadow: short.length && relevant ? 'inset 0 -3px 0 var(--warn)' : undefined,
                  }}
                >
                  {seats !== undefined ? `${ph.name} · ${Math.round(seats * 10) / 10}` : ph.name}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function PhaseLegend() {
  return (
    <div className="legend">
      {(Object.keys(PHASE_COLOR) as ProjectPhase['kind'][]).map((k) => (
        <span key={k}>
          <i style={{ background: PHASE_COLOR[k] }} />
          {k.replace('-', ' ').replace(/^./, (c) => c.toUpperCase())}
        </span>
      ))}
      <span>
        <i style={{ border: '1.5px dashed var(--text-2)', background: 'transparent' }} />
        Tentative dates
      </span>
      <span>
        <i style={{ background: 'transparent', boxShadow: 'inset 0 -3px 0 var(--warn)' }} />
        Forecast shortage in phase
      </span>
    </div>
  );
}
