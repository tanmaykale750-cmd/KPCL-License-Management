/**
 * Planning chart in Theme E drafting conventions.
 *   actual demand  — solid graphite line
 *   P50 forecast   — dashed teal line
 *   P90            — pale teal band (P50 → P90)
 *   owned capacity — graphite step line
 *   forecast shortage — hatched warning band, labelled
 *   actual shortage   — solid critical band, labelled
 */
import { useMemo, useState } from 'react';
import { runs, type ForecastPoint, type ForecastResult } from '../../calc/forecast';
import { FORECAST_START } from '../../data/generate';
import { addWeeks, fmtDate } from '../../lib/dates';
import { tickLabel, type TimeScale } from './Gantt';

export interface CanvasProps {
  f: ForecastResult;
  scale: TimeScale;
  height?: number;
  historyWeeks?: number;
  capacityAt?: (week: string) => number;
  baseline?: { points: ForecastPoint[]; capacityAt: (w: string) => number; label: string };
  selectedWeek?: string;
  onSelectWeek?: (w: string) => void;
  projectName?: (id: string) => string;
  annotate?: boolean;
  unit?: string;
}

export function PlanningCanvas({ f, scale, height = 300, historyWeeks = 26, capacityAt, baseline, selectedWeek, onSelectWeek, projectName = (x) => x, annotate = true, unit = 'seats' }: CanvasProps) {
  const [hover, setHover] = useState<string | null>(null);
  const hist = f.history.slice(-historyWeeks);
  const pts = f.points;
  const cap = (w: string, fallback: number) => (capacityAt ? capacityAt(w) : fallback);
  const top = 22;
  const bottom = 26;
  const plotH = height - top - bottom;
  const yMax = useMemo(() => {
    const m = Math.max(...hist.map((h) => Math.max(h.demand, h.capacity)), ...pts.map((p) => Math.max(p.p90, cap(p.week, p.capacity))), ...(baseline?.points.map((p) => p.p90) ?? [0]));
    return Math.ceil(m + 1);
  }, [hist, pts, baseline]); // eslint-disable-line react-hooks/exhaustive-deps
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const x = (w: string) => scale.x(w);
  const xMid = (w: string) => scale.x(addWeeks(w, 0)) + (scale.x(addWeeks(w, 1)) - scale.x(w)) / 2;
  const right = scale.left + scale.width;
  const step = yMax > 24 ? 5 : yMax > 12 ? 2 : 1;
  const yTicks = Array.from({ length: Math.floor(yMax / step) + 1 }, (_, i) => i * step);

  // Paths
  const actualPath = hist.map((h, i) => `${i ? 'L' : 'M'}${xMid(h.week).toFixed(1)},${y(h.demand).toFixed(1)}`).join('');
  const capSteps = [...hist.map((h) => ({ w: h.week, c: h.capacity })), ...pts.map((p) => ({ w: p.week, c: cap(p.week, p.capacity) }))];
  const capPath = capSteps.map((s, i) => `${i ? `L${x(s.w).toFixed(1)},${y(capSteps[i - 1].c).toFixed(1)}L` : 'M'}${x(s.w).toFixed(1)},${y(s.c).toFixed(1)}`).join('') + `L${right},${y(capSteps[capSteps.length - 1].c)}`;
  const p50Path = pts.map((p, i) => `${i ? 'L' : 'M'}${xMid(p.week).toFixed(1)},${y(p.p50).toFixed(1)}`).join('');
  const band = pts.map((p, i) => `${i ? 'L' : 'M'}${xMid(p.week).toFixed(1)},${y(p.p90).toFixed(1)}`).join('') + [...pts].reverse().map((p) => `L${xMid(p.week).toFixed(1)},${y(p.p50).toFixed(1)}`).join('') + 'Z';
  const baseP50 = baseline ? baseline.points.map((p, i) => `${i ? 'L' : 'M'}${xMid(p.week).toFixed(1)},${y(p.p50).toFixed(1)}`).join('') : '';
  const baseCap = baseline
    ? baseline.points.map((p, i) => `${i ? `L${x(p.week).toFixed(1)},${y(baseline.capacityAt(baseline.points[i - 1].week)).toFixed(1)}L` : 'M'}${x(p.week).toFixed(1)},${y(baseline.capacityAt(p.week)).toFixed(1)}`).join('')
    : '';

  const forecastShort = runs(pts.filter((p) => p.p90 > cap(p.week, p.capacity) + 0.05).map((p) => p.week));
  const actualShort = runs(hist.filter((h) => h.demand > h.capacity).map((h) => h.week));
  const peak = pts.reduce<ForecastPoint | null>((m, p) => (!m || p.p90 - cap(p.week, p.capacity) > m.p90 - cap(m.week, m.capacity) ? p : m), null);
  const months = [...new Set([...hist.map((h) => h.week), ...pts.map((p) => p.week)].map((w) => w.slice(0, 7)))].map((m) => `${m}-01`).filter((d) => d >= scale.start);
  const hoverPt = hover ? pts.find((p) => p.week === hover) : null;
  const hoverHist = hover ? hist.find((h) => h.week === hover) : null;
  const allWeeks = [...hist.map((h) => h.week), ...pts.map((p) => p.week)];

  return (
    <div style={{ position: 'relative' }}>
      <svg width="100%" height={height} viewBox={`0 0 ${right + 70} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${f.licence.product} weekly peak demand, forecast and owned capacity`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <pattern id="hatch-warn" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="rgba(154,91,0,0.06)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(154,91,0,0.42)" strokeWidth="2" />
          </pattern>
        </defs>
        {/* grid */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={scale.left} x2={right} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
            <text x={scale.left - 8} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--chart-axis)" className="mono">
              {t}
            </text>
          </g>
        ))}
        {months.map((m) => (
          <g key={m}>
            <line x1={x(m)} x2={x(m)} y1={top} y2={top + plotH} stroke="var(--chart-grid)" strokeDasharray="2 3" />
            <text x={x(m) + 3} y={height - 8} fontSize="10.5" fill="var(--chart-axis)" className="mono">
              {tickLabel(m)}
            </text>
          </g>
        ))}
        <text x={scale.left - 8} y={top - 8} textAnchor="end" fontSize="10.5" fill="var(--chart-axis)">
          {unit}
        </text>
        {/* shortage bands */}
        {actualShort.map((r) => (
          <g key={`a${r.start}`}>
            <rect x={x(r.start)} y={top} width={Math.max(3, x(addWeeks(r.end, 1)) - x(r.start))} height={plotH} fill="rgba(166,27,27,0.12)" />
            <rect x={x(r.start)} y={top} width={Math.max(3, x(addWeeks(r.end, 1)) - x(r.start))} height={3} fill="var(--crit)" />
          </g>
        ))}
        {actualShort.length > 0 && (
          <text x={x(actualShort[0].start) + 2} y={top + 14} fontSize="10.5" fontWeight="600" fill="var(--crit)">
            Actual shortage
          </text>
        )}
        {forecastShort.map((r) => (
          <g key={`f${r.start}`}>
            <rect x={x(r.start)} y={top} width={Math.max(3, x(addWeeks(r.end, 1)) - x(r.start))} height={plotH} fill="url(#hatch-warn)" />
            <text x={x(r.start) + 3} y={top + 12} fontSize="10.5" fontWeight="600" fill="var(--warn)">
              Forecast shortage · {fmtDate(r.start).slice(0, 6)}–{fmtDate(addWeeks(r.end, 1)).slice(0, 6)}
            </text>
          </g>
        ))}
        {/* today divider */}
        <line x1={x(FORECAST_START)} x2={x(FORECAST_START)} y1={top - 6} y2={top + plotH} stroke="var(--copper)" strokeWidth="1.25" strokeDasharray="4 3" />
        <text x={x(FORECAST_START) + 4} y={top - 8} fontSize="10.5" fontWeight="600" fill="var(--copper)">
          Forecast →
        </text>
        {/* baseline overlay */}
        {baseline && (
          <>
            <path d={baseCap} fill="none" stroke="var(--border-strong)" strokeWidth="1.5" strokeDasharray="2 3" />
            <path d={baseP50} fill="none" stroke="var(--teal-soft)" strokeWidth="1.5" strokeDasharray="5 4" />
          </>
        )}
        {/* forecast */}
        <path d={band} fill="var(--chart-band)" stroke="none" />
        <path d={capPath} fill="none" stroke="var(--chart-capacity)" strokeWidth="2" strokeLinejoin="miter" />
        <path d={p50Path} fill="none" stroke="var(--chart-p50)" strokeWidth="2" strokeDasharray="6 4" />
        <path d={actualPath} fill="none" stroke="var(--chart-actual)" strokeWidth="2" />
        {hist.map((h) => (
          <circle key={h.week} cx={xMid(h.week)} cy={y(h.demand)} r={1.8} fill="var(--chart-actual)" />
        ))}
        <text x={right + 6} y={y(capSteps[capSteps.length - 1].c) + 4} fontSize="11" fontWeight="600" fill="var(--chart-capacity)">
          Owned {Math.round(capSteps[capSteps.length - 1].c * 10) / 10}
        </text>
        {/* annotation: drivers at the worst week */}
        {annotate && peak && peak.p90 > cap(peak.week, peak.capacity) + 0.05 && (() => {
          const px = xMid(peak.week);
          const flip = px > right - 240;
          const tx = flip ? px - 6 : px + 6;
          const anchor = flip ? 'end' : 'start';
          return (
            <g>
              <line x1={px} x2={px} y1={y(peak.p90) - 2} y2={y(peak.p90) - 22} stroke="var(--text-2)" strokeWidth="1" />
              <circle cx={px} cy={y(peak.p90)} r={3} fill="var(--panel)" stroke="var(--text)" strokeWidth="1.25" />
              <text x={tx} y={Math.max(top + 32, y(peak.p90) - 26)} textAnchor={anchor} fontSize="11" fill="var(--text)" fontWeight="600" paintOrder="stroke" stroke="var(--panel)" strokeWidth="3">
                P90 {peak.p90.toFixed(1)} vs owned {cap(peak.week, peak.capacity).toFixed(1)}
              </text>
              <text x={tx} y={Math.max(top + 45, y(peak.p90) - 13)} textAnchor={anchor} fontSize="10.5" fill="var(--text-2)" paintOrder="stroke" stroke="var(--panel)" strokeWidth="3">
                base {peak.baseline.toFixed(1)}
                {peak.projects
                  .filter((c) => c.seats > 0.05)
                  .map((c) => ` + ${c.seats.toFixed(1)} ${projectName(c.projectId)}`)
                  .join('')}
              </text>
            </g>
          );
        })()}
        {/* selected / hover week */}
        {selectedWeek && <rect x={x(selectedWeek)} y={top} width={Math.max(2, x(addWeeks(selectedWeek, 1)) - x(selectedWeek))} height={plotH} fill="none" stroke="var(--teal)" strokeWidth="1.5" />}
        {hover && <line x1={xMid(hover)} x2={xMid(hover)} y1={top} y2={top + plotH} stroke="var(--text-2)" strokeWidth="1" strokeDasharray="1 2" />}
        {/* hit areas */}
        {allWeeks.map((w) => (
          <rect
            key={w}
            x={x(w)}
            y={top}
            width={Math.max(1, x(addWeeks(w, 1)) - x(w))}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(w)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onSelectWeek?.(w)}
            style={{ cursor: onSelectWeek && w >= FORECAST_START ? 'pointer' : 'default' }}
          />
        ))}
        <line x1={scale.left} x2={right} y1={top + plotH} y2={top + plotH} stroke="var(--border-strong)" />
      </svg>
      {hover && (hoverPt || hoverHist) && (
        <div className="chart-tooltip" style={{ position: 'absolute', top: 8, left: Math.min(xMid(hover) + 12, right - 210) * 0.98, pointerEvents: 'none' }}>
          <div className="t">Week of {fmtDate(hover)}</div>
          {hoverHist && (
            <>
              <div className="r">
                Peak demand <b>{hoverHist.demand}</b>
              </div>
              <div className="r">
                Owned <b>{hoverHist.capacity}</b>
              </div>
              <div className="r">
                Denials <b>{hoverHist.denials}</b>
              </div>
              <div className="r">
                Blocked <b>{hoverHist.blocked} h</b>
              </div>
            </>
          )}
          {hoverPt && (
            <>
              <div className="r">
                P50 forecast <b>{hoverPt.p50.toFixed(1)}</b>
              </div>
              <div className="r">
                P90 <b>{hoverPt.p90.toFixed(1)}</b>
              </div>
              <div className="r">
                Owned <b>{cap(hoverPt.week, hoverPt.capacity).toFixed(1)}</b>
              </div>
              <div className="small muted" style={{ marginTop: 3 }}>
                {onSelectWeek ? 'Click to explain this week' : ''}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function CanvasLegend({ baseline }: { baseline?: string }) {
  return (
    <div className="legend">
      <span>
        <i className="line" style={{ background: 'var(--chart-actual)' }} />
        Actual peak demand
      </span>
      <span>
        <i className="dashed" />
        P50 forecast
      </span>
      <span>
        <i style={{ background: 'var(--chart-band)', border: '1px solid var(--teal-soft)' }} />
        P50–P90 band
      </span>
      <span>
        <i className="line" style={{ background: 'var(--chart-capacity)', height: 3 }} />
        Owned capacity (step)
      </span>
      <span>
        <i className="hatch" />
        Forecast shortage
      </span>
      <span>
        <i style={{ background: 'rgba(166,27,27,0.25)', borderTop: '2px solid var(--crit)' }} />
        Actual shortage
      </span>
      {baseline && (
        <span>
          <i className="line" style={{ background: 'var(--border-strong)' }} />
          {baseline}
        </span>
      )}
    </div>
  );
}
