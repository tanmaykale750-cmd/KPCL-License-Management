import type { ReactNode } from 'react';
import type { Filters } from '../../calc/metrics';
import { useApp } from '../../state/store';

export function FilterBar({ filters, onChange, right, lockDept }: { filters: Filters; onChange: (f: Partial<Filters>) => void; right?: ReactNode; lockDept?: boolean }) {
  const { ds } = useApp();
  const families = [...new Set(ds.licences.map((l) => l.family))];
  return (
    <div className="filter-row" role="group" aria-label="Filters">
      <select className="select" aria-label="Period" value={filters.months} onChange={(e) => onChange({ months: Number(e.target.value) as Filters['months'] })}>
        <option value={3}>Last 3 months</option>
        <option value={6}>Last 6 months</option>
        <option value={12}>Last 12 months</option>
      </select>
      <select className="select" aria-label="Department" value={filters.deptId} disabled={lockDept} onChange={(e) => onChange({ deptId: e.target.value })}>
        <option value="all">All Departments</option>
        {ds.departments.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      <select className="select" aria-label="Software" value={filters.family} onChange={(e) => onChange({ family: e.target.value })}>
        <option value="all">All Software</option>
        {families.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <select className="select" aria-label="Licence type" value={filters.type} onChange={(e) => onChange({ type: e.target.value as Filters['type'] })}>
        <option value="all">All Licence Types</option>
        <option value="floating">Floating</option>
        <option value="named">Named user</option>
        <option value="node-locked">Node-locked</option>
        <option value="token">Token / unit</option>
      </select>
      <div className="spacer" />
      {right}
    </div>
  );
}
