import { useSearchParams } from 'react-router-dom';
import { useApp } from '../../state/store';

export type PlanTab = 'forecast' | 'supply' | 'optimise' | 'whatif' | 'assistant';

export function usePlanning() {
  const { ds } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as PlanTab) || 'forecast';
  const pools = ds.licences.filter((l) => l.forecastable);
  const licenceId = pools.some((l) => l.id === params.get('licence')) ? params.get('licence')! : 'ANS-MECH';
  const horizon = Number(params.get('h')) || 26;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next);
  };
  return { tab, licenceId, horizon, pools, set, params };
}
