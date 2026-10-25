/** Licence cover per project phase: covered, tight or short — from the same forecast the Planning Studio uses. */
import type { Dataset } from '../data/dataset';
import type { Project, ProjectPhase } from '../domain/types';
import { weekStart } from '../lib/dates';
import { forecast, type ForecastResult } from './forecast';

export type Cover = 'covered' | 'tight' | 'short' | 'past' | 'named';

export interface PhaseCover {
  licenceId: string;
  seats: number;
  cover: Cover;
  shortWeeks: string[];
  competing: { projects: number; seats: number };
}

export function phaseCover(ds: Dataset, project: Project, phase: ProjectPhase, cache: Map<string, ForecastResult>, projects = ds.projects): PhaseCover[] {
  return phase.demand.map((d) => {
    const lic = ds.licences.find((l) => l.id === d.licenceId);
    const competingProjects = projects.filter(
      (p) => p.id !== project.id && p.status !== 'completed' && p.phases.some((ph) => ph.start <= phase.end && phase.start <= ph.end && ph.demand.some((x) => x.licenceId === d.licenceId)),
    );
    const competing = {
      projects: competingProjects.length,
      seats: competingProjects.reduce((s, p) => s + p.phases.filter((ph) => ph.start <= phase.end && phase.start <= ph.end).reduce((a, ph) => a + (ph.demand.find((x) => x.licenceId === d.licenceId)?.seats ?? 0), 0), 0),
    };
    if (!lic || !lic.forecastable) return { licenceId: d.licenceId, seats: d.seats, cover: 'named' as const, shortWeeks: [], competing };
    if (phase.end < '2026-10-26') return { licenceId: d.licenceId, seats: d.seats, cover: 'past' as const, shortWeeks: [], competing };
    let f = cache.get(lic.id);
    if (!f) {
      f = forecast(ds, lic.id, { horizonWeeks: 30, projects });
      cache.set(lic.id, f);
    }
    const pts = f.points.filter((p) => p.week >= weekStart(phase.start) && p.week <= phase.end);
    const short = pts.filter((p) => p.p50 > p.capacity + 0.05).map((p) => p.week);
    const tight = pts.filter((p) => p.p90 > p.capacity + 0.05).map((p) => p.week);
    return { licenceId: d.licenceId, seats: d.seats, cover: short.length ? 'short' : tight.length ? 'tight' : 'covered', shortWeeks: short.length ? short : tight, competing };
  });
}
