import { useMemo } from 'react';
import { forecast, shortageSummary, type ForecastResult, type ShortageSummary } from '../calc/forecast';
import { useApp } from '../state/store';

export interface PoolForecast {
  f: ForecastResult;
  s: ShortageSummary;
}

/** 26-week forecasts for every shared pool, computed once per dataset version. */
export function useForecasts(horizonWeeks = 26): Record<string, PoolForecast> {
  const { ds } = useApp();
  return useMemo(() => {
    const out: Record<string, PoolForecast> = {};
    for (const l of ds.licences.filter((x) => x.forecastable)) {
      const f = forecast(ds, l.id, { horizonWeeks });
      out[l.id] = { f, s: shortageSummary(f) };
    }
    return out;
  }, [ds, horizonWeeks]);
}
