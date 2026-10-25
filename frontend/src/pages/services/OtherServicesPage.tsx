import { AlertOctagon, CalendarClock, ChevronRight, CloudOff, Download, Info, KeyRound, Lock, Search, TrendingUp, type LucideIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  allKeys,
  BILLING_LABEL,
  CATEGORY_LABEL,
  DEFAULT_SERVICE_FILTERS,
  filterServices,
  formatQty,
  idleServices,
  ownerRows,
  quotaHitRows,
  rarelyUsedKeys,
  RARE_KEY_DAYS,
  RENEWAL_WINDOW_DAYS,
  serviceDeptRows,
  serviceRows,
  serviceTrend,
  spendOutliers,
  summariseServices,
  SUBTYPE_LABEL,
  unusedCloud,
  upcomingRenewals,
  type ServiceDeptRow,
  type ServiceFilters,
  type ServiceRow,
} from '../../calc/services';
import { CATEGORY_COLORS, SERVICE_COLORS, ServiceDeptBars, ServiceTrendChart } from '../../components/charts/ServiceCharts';
import { SpendDonut, type DonutSlice } from '../../components/charts/SpendDonut';
import { DataTable } from '../../components/ui/DataTable';
import { StatusChip } from '../../components/ui/StatusChip';
import { MiniBar, PageHead, Panel, SectionLabel, Tabs } from '../../components/ui/basics';
import { getServices } from '../../data/services';
import type { ServiceBilling, ServiceCategory } from '../../domain/types';
import { downloadCSV } from '../../lib/csv';
import { fmtDate, monthLabel } from '../../lib/dates';
import { hours, inrShort, num, pct } from '../../lib/format';
import { useApp } from '../../state/store';
import { ServiceDrawer } from './ServiceDrawer';

type View = 'services' | 'owners';

const DEPT_COLORS = ['#0e6b68', '#2f8a85', '#5f8f8c', '#7fb3ae', '#a9cfcb', '#2a3236'];
const UNALLOCATED_COLOR = '#c58a5c';

function Kpi({ label, value, unit, meta, title, onClick }: { label: string; value: string; unit?: string; meta: ReactNode; title: string; onClick: () => void }) {
  return (
    <button className="kpi" onClick={onClick} title={title}>
      <div className="kpi-label">
        {label}
        <Info className="info" aria-hidden />
      </div>
      <div className="kpi-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="kpi-meta">{meta}</div>
    </button>
  );
}

function Delta({ now, prev, pts, goodWhen }: { now: number; prev: number; pts?: boolean; goodWhen: 'up' | 'down' }) {
  if (!pts && prev === 0) return <span className="delta flat">{now > 0 ? 'new' : '±0'}</span>;
  const d = pts ? (now - prev) * 100 : prev ? ((now - prev) / prev) * 100 : 0;
  const flat = Math.abs(d) < 0.5;
  const good = (d > 0 && goodWhen === 'up') || (d < 0 && goodWhen === 'down');
  return <span className={`delta ${flat ? 'flat' : good ? 'good' : 'bad'}`}>{flat ? '±0' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(pts ? 1 : 0)}${pts ? ' pts' : '%'}`}</span>;
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function SummaryPanel({ items }: { items: { id: string; icon: LucideIcon; title: string; detail: string; target: string; tone: 'warn' | 'crit' | 'info' }[] }) {
  const TONE = { warn: { bg: 'rgba(226,168,90,0.16)', fg: '#e2a85a' }, crit: { bg: 'rgba(222,110,100,0.18)', fg: '#e8918a' }, info: { bg: 'rgba(124,194,189,0.16)', fg: '#7cc2bd' } };
  return (
    <section className="panel panel-dark" aria-labelledby="svc-summary-h">
      <div className="panel-head" style={{ paddingBottom: 6 }}>
        <div>
          <h2 id="svc-summary-h">What the records show</h2>
          <div className="sub">Measured from billing and usage · tracking only, no recommendations</div>
        </div>
      </div>
      <div style={{ padding: '0 8px 8px' }}>
        {items.map((a) => (
          <button
            key={a.id}
            className="ink-row"
            onClick={() => scrollTo(a.target)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '9px 8px', border: 0, borderTop: '1px solid var(--ink-rule)', background: 'transparent', color: 'var(--ink-text)', textAlign: 'left', borderRadius: 0 }}
          >
            <span style={{ width: 30, height: 30, borderRadius: 4, background: TONE[a.tone].bg, color: TONE[a.tone].fg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <a.icon size={16} aria-hidden strokeWidth={1.8} />
            </span>
            <span className="grow">
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{a.title}</span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-text-2)', marginTop: 2 }}>{a.detail}</span>
            </span>
            <span style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-text-2)', border: '1px dashed var(--ink-rule)', padding: '2px 5px', borderRadius: 3 }}>Measured</span>
            <ChevronRight size={16} aria-hidden style={{ color: 'var(--ink-text-2)', flex: 'none' }} />
          </button>
        ))}
      </div>
    </section>
  );
}

export default function OtherServicesPage() {
  const { ds, perms } = useApp();
  const [params, setParams] = useSearchParams();
  const scopeDept = perms.deptScope;
  const scoped = !!scopeDept;
  const showOwners = perms.seesIndividuals || scoped; // administrators; department heads for their own department
  const [f, setF] = useState<ServiceFilters>({ ...DEFAULT_SERVICE_FILTERS, deptId: scopeDept ?? 'all' });
  const [q, setQ] = useState('');
  const filters: ServiceFilters = scoped ? { ...f, deptId: scopeDept! } : f;
  const askedView = (params.get('view') as View) || 'services';
  const view: View = askedView === 'owners' && showOwners ? 'owners' : 'services';
  const openId = params.get('open');
  const setParam = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (v === null) n.delete(k);
    else n.set(k, v);
    setParams(n, { replace: true });
  };

  const all = getServices();
  const list = useMemo(() => filterServices(all, filters), [all, filters.deptId, filters.category, filters.billing]); // eslint-disable-line react-hooks/exhaustive-deps
  const companyList = useMemo(() => filterServices(all, { ...filters, deptId: 'all' }), [all, filters.category, filters.billing]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = summariseServices(list, filters.months);
  const prev = summariseServices(list, filters.months, 1);
  const company = summariseServices(companyList, filters.months);
  const deptName = (id: string | null) => (id === null ? 'Unallocated' : ds.departments.find((d) => d.id === id)?.name ?? id);
  const userName = (id: string) => ds.users.find((u) => u.id === id)?.name ?? id;

  // Department chart: every department for company-wide roles; own department vs the rest for a department head.
  const companyDeptRows = serviceDeptRows(companyList, filters.months, ds.departments);
  const deptRows: (ServiceDeptRow & { muted?: boolean })[] = scoped
    ? (() => {
        const own = companyDeptRows.find((r) => r.deptId === scopeDept);
        const rest = companyDeptRows.filter((r) => r.deptId !== scopeDept);
        const sum = (k: keyof ServiceDeptRow) => rest.reduce((a, r) => a + (r[k] as number), 0);
        const other: ServiceDeptRow & { muted: boolean } = { deptId: 'others', name: 'Rest of company', spend: sum('spend'), usedCapacity: sum('usedCapacity'), idle: sum('idle'), metered: sum('metered'), util: sum('usedCapacity') / Math.max(1, sum('usedCapacity') + sum('idle')), services: sum('services'), muted: true };
        return own ? [own, other] : [other];
      })()
    : companyDeptRows;

  const slices: DonutSlice[] = scoped
    ? [
        ...companyDeptRows.filter((r) => r.deptId === scopeDept).map((r) => ({ key: r.deptId, label: r.name, value: r.spend, color: DEPT_COLORS[0], note: `${pct(r.util)} of paid capacity in use` })),
        { key: 'others', label: 'Other departments', value: companyDeptRows.filter((r) => r.deptId !== scopeDept && r.deptId !== 'unallocated').reduce((a, r) => a + r.spend, 0), color: '#a9b4b3', note: 'Company total, other departments' },
        ...companyDeptRows.filter((r) => r.deptId === 'unallocated').map((r) => ({ key: 'unallocated', label: 'Unallocated', value: r.spend, color: UNALLOCATED_COLOR, note: 'Shared services not yet charged to a department' })),
      ]
    : companyDeptRows.map((r, i) => ({ key: r.deptId, label: r.name, value: r.spend, color: r.deptId === 'unallocated' ? UNALLOCATED_COLOR : DEPT_COLORS[i % DEPT_COLORS.length], note: r.usedCapacity + r.idle > 0 ? `${pct(r.util)} of paid capacity in use · ${r.services} services` : 'Pay-as-you-go only' }));
  const donutTotal = slices.reduce((a, x) => a + x.value, 0);
  const sliceUtil = (key: string) => (key === 'others' ? null : companyDeptRows.find((r) => r.deptId === key));

  // Detail data
  const rows = serviceRows(list, filters.months);
  const ql = q.trim().toLowerCase();
  const match = (r: ServiceRow) => !ql || [r.s.name, r.s.provider, r.s.id, deptName(r.s.deptId), showOwners ? userName(r.s.ownerUserId) : '', ...r.s.keys.map((k) => `${k.masked} ${k.label}`)].join(' ').toLowerCase().includes(ql);
  const shown = rows.filter(match);
  const keys = allKeys(list).filter((k) => !ql || `${k.key.masked} ${k.key.label} ${k.service.name} ${showOwners ? userName(k.key.ownerUserId) : ''}`.toLowerCase().includes(ql));
  const owners = showOwners ? ownerRows(list, filters.months).filter((o) => !ql || `${userName(o.ownerUserId)} ${o.depts.map(deptName).join(' ')}`.toLowerCase().includes(ql)) : [];
  const idle = idleServices(rows);
  const unused = unusedCloud(list);
  const rareKeys = rarelyUsedKeys(list);
  const limits = quotaHitRows(rows);
  const outliers = spendOutliers(list, filters.months);
  const trend = serviceTrend(list, 12);
  const renewalRows = useMemo(
    () =>
      upcomingRenewals(list).map((r) => ({
        id: r.id,
        label: r.kind === 'key' ? r.service.keys.find((k) => k.id === r.id)?.masked ?? r.label : r.label,
        sid: r.service.id,
        date: r.date,
        days: r.days,
        what: r.kind === 'key' ? `API key expires · ${r.service.name.split(' — ')[0]}` : r.what,
        value: r.annualValue,
      })),
    [list],
  );
  const openSvc = all.find((x) => x.id === openId && list.includes(x)) ?? null;

  const set = (patch: Partial<ServiceFilters>) => setF((x) => ({ ...x, ...patch }));

  const exportCsv = () => {
    if (view === 'owners')
      return downloadCSV('other-services-owners-sample.csv', owners.map((o) => ({ owner: userName(o.ownerUserId), departments: o.depts.map(deptName).join('; '), services: o.services, keys: o.keys, keys_rarely_used: o.rareKeys, annual_spend_inr: Math.round(o.spend), annual_idle_inr: Math.round(o.idle), quota_hits: o.quotaHits })));
    downloadCSV(
      'other-services-inventory-sample.csv',
      shown.map((r) => ({
        id: r.s.id,
        service: r.s.name,
        provider: r.s.provider,
        category: CATEGORY_LABEL[r.s.category],
        type: SUBTYPE_LABEL[r.s.subType],
        ...(showOwners ? { owner: userName(r.s.ownerUserId) } : {}),
        department: deptName(r.s.deptId),
        billing: BILLING_LABEL[r.s.billing],
        paid_capacity_per_month: r.s.capacity !== null ? `${r.s.capacity} ${r.s.unit}` : 'pay-as-you-go',
        avg_usage_per_month: `${Math.round(r.st.avgUsage * 10) / 10} ${r.s.unit}`,
        utilisation_pct: r.st.util === null ? 'n/a' : Math.round(r.st.util * 100),
        [`spend_${filters.months}m_inr`]: Math.round(r.st.spend),
        [`idle_${filters.months}m_inr`]: Math.round(r.st.idle),
        quota_hits: r.st.quotaHits,
        blocked_hours: r.st.blockedHours,
        api_keys_masked: r.s.keys.map((k) => k.masked).join(' '),
        renewal_or_expiry: r.s.renewalDate ?? '',
      })),
    );
  };

  const summaryItems = [
    { id: 'q', icon: AlertOctagon, tone: 'crit' as const, target: 'svc-limits', title: `${num(s.quotaHits)} quota / limit hits · ${hours(s.blockedHours)} blocked`, detail: limits.length ? `${limits.map((r) => r.s.name.split(' — ')[0]).slice(0, 2).join(', ')} — last ${filters.months} months` : 'No limit hits in this period' },
    { id: 'c', icon: CloudOff, tone: 'warn' as const, target: 'svc-unused', title: `${unused.length} cloud resource${unused.length === 1 ? '' : 's'} with almost no use`, detail: `${inrShort(unused.reduce((a, r) => a + r.monthlyIdle, 0))} a month billed, under 15% busy (last 3 months)` },
    { id: 'k', icon: KeyRound, tone: 'warn' as const, target: 'svc-keys', title: `${rareKeys.length} API key${rareKeys.length === 1 ? '' : 's'} rarely used`, detail: `No calls for ${RARE_KEY_DAYS}+ days or under 50 calls in 30 days` },
    { id: 'o', icon: TrendingUp, tone: 'info' as const, target: 'svc-outliers', title: `${outliers.length} spend outlier${outliers.length === 1 ? '' : 's'}`, detail: outliers[0] ? `${outliers[0].service.name.split(' — ')[0]}, ${monthLabel(outliers[0].month, true)}: ${outliers[0].ratio.toFixed(1)}× usual` : 'No month above 1.5× its usual spend' },
    { id: 'r', icon: CalendarClock, tone: 'info' as const, target: 'svc-renewals', title: `${renewalRows.length} renewals and key expiries`, detail: `Within ${RENEWAL_WINDOW_DAYS} days · ${inrShort(renewalRows.reduce((a, r) => a + r.value, 0))} a year of commitments` },
  ];

  return (
    <>
      <PageHead title="Other Services" sub="API keys, AI token use and cloud computing — what is paid for, what is used, and where limits bite." />
      <div className="filter-row" role="group" aria-label="Filters">
        <select className="select" aria-label="Period" value={filters.months} onChange={(e) => set({ months: Number(e.target.value) as ServiceFilters['months'] })}>
          <option value={3}>Last 3 months</option>
          <option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option>
        </select>
        <select className="select" aria-label="Department" value={filters.deptId} disabled={scoped} onChange={(e) => set({ deptId: e.target.value })}>
          <option value="all">All Departments</option>
          {ds.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          <option value="unallocated">Unallocated</option>
        </select>
        <select className="select" aria-label="Service category" value={filters.category} onChange={(e) => set({ category: e.target.value as 'all' | ServiceCategory })}>
          <option value="all">All Categories</option>
          <option value="api">API keys & services</option>
          <option value="ai">AI tokens</option>
          <option value="cloud">Cloud computing</option>
        </select>
        <select className="select" aria-label="Billing type" value={filters.billing} onChange={(e) => set({ billing: e.target.value as 'all' | ServiceBilling })}>
          <option value="all">All Billing Types</option>
          {(Object.keys(BILLING_LABEL) as ServiceBilling[]).map((b) => (
            <option key={b} value={b}>
              {BILLING_LABEL[b]}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {scoped && (
          <span className="scope-note">
            <Lock size={13} aria-hidden /> Scoped to {deptName(scopeDept)} · others as company totals
          </span>
        )}
        {!scoped && !showOwners && (
          <span className="scope-note">
            <Lock size={13} aria-hidden /> Company-wide summary · owner names hidden
          </span>
        )}
        <button className="btn primary" onClick={exportCsv} title="Download the current table as CSV (sample data)">
          <Download /> Export
        </button>
      </div>

      <div className="kpi-grid">
        <Kpi label="Services & Keys Held" value={num(s.services)} unit={`+ ${s.keys} keys`} title="Tracked services and the API keys issued for them" onClick={() => scrollTo('svc-inventory')} meta={<span>{s.byCategory.api} API · {s.byCategory.ai} AI · {s.byCategory.cloud} cloud</span>} />
        <Kpi label="Annual Service Spend" value={inrShort(s.annualSpend)} title={`Billed spend in the last ${filters.months} months × 12 ÷ ${filters.months}`} onClick={() => scrollTo('svc-trend')} meta={scoped ? <span>Company {inrShort(company.annualSpend)}</span> : <span>{inrShort((s.meteredSpend * 12) / filters.months)} pay-as-you-go & overage</span>} />
        <Kpi label="Utilisation" value={pct(s.util)} title="Share of paid capacity actually used (1 − idle ÷ capacity spend). Pay-as-you-go is excluded." onClick={() => scrollTo('svc-idle')} meta={<><Delta now={s.util} prev={prev.util} pts goodWhen="up" /><span>vs previous {filters.months} months</span></>} />
        <Kpi label="Idle Spend" value={inrShort(s.annualIdle)} title="Commitments: fee × unused share. Provisioned cloud: spend × idle share. Pay-as-you-go: never idle." onClick={() => scrollTo('svc-idle')} meta={<span>{pct(s.capacitySpend ? s.idle / s.capacitySpend : 0)} of paid capacity · annualised</span>} />
        <Kpi label="Engineer-Hours Blocked" value={num(s.blockedHours)} unit="hrs" title="Hours engineers waited because a quota, rate limit or instance limit was reached" onClick={() => scrollTo('svc-limits')} meta={<><Delta now={s.blockedHours} prev={prev.blockedHours} goodWhen="down" /><span>vs prev. {filters.months} months · {num(s.quotaHits)} limit hits</span></>} />
      </div>

      <div className="grid-3">
        <Panel
          title="Spend vs Use by Department"
          sub="Annualised spend, ₹ lakh · % = paid capacity in use"
          actions={
            <div className="legend">
              <span><i style={{ background: SERVICE_COLORS.used }} />In use</span>
              <span><i style={{ background: SERVICE_COLORS.idle }} />Idle</span>
              <span><i style={{ background: SERVICE_COLORS.metered }} />Pay-as-you-go</span>
            </div>
          }
          footer={<span className="takeaway">Pay-as-you-go spend is billed only for use, so it is never counted as idle.{!scoped && ' Click a bar to filter.'}</span>}
        >
          <ServiceDeptBars rows={deptRows} height={scoped ? 120 : 210} selected={filters.deptId} onSelect={scoped ? undefined : (id) => set({ deptId: filters.deptId === id ? 'all' : id })} />
        </Panel>

        <Panel title="Spend by Department" sub={`Annualised · last ${filters.months} months`} footer={<span className="takeaway">Unallocated = shared services not yet charged to a department.</span>}>
          <SpendDonut slices={slices} centreLabel="Total" centreValue={inrShort(donutTotal)} size={138} />
          <div className="stack" style={{ gap: 2, marginTop: 8 }}>
            {slices.map((x) => {
              const r = sliceUtil(x.key);
              return (
                <div key={x.key} className="row-between small">
                  <span className="row" style={{ gap: 6 }}>
                    <i style={{ width: 9, height: 9, borderRadius: 2, background: x.color, display: 'inline-block' }} />
                    {x.label}
                  </span>
                  <span className="num">
                    <b style={{ fontWeight: 600 }}>{pct(donutTotal ? x.value / donutTotal : 0)}</b>
                    <span className="muted"> · {r && r.usedCapacity + r.idle > 0 ? `${pct(r.util)} used` : '—'}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>

        <SummaryPanel items={summaryItems} />
      </div>

      <SectionLabel>Service inventory</SectionLabel>
      <div id="svc-inventory" className="row-between" style={{ marginBottom: 8, gap: 12 }}>
        <Tabs
          label="Inventory views"
          value={view}
          onChange={(v) => setParam('view', v === 'services' ? null : v)}
          tabs={[
            { id: 'services', label: 'Service / Key view', count: shown.length },
            { id: 'owners', label: 'Owner view', hidden: !showOwners },
          ]}
        />
        <label className="search" style={{ width: 300 }}>
          <Search aria-hidden />
          <input aria-label="Search services, providers, owners or masked keys" placeholder="Search service, provider, owner or key…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      {view === 'services' && (
        <>
          <Panel flush title="Services" sub={`Last ${filters.months} months · click a row for monthly usage, billing and keys`}>
            <DataTable
              rows={shown}
              rowKey={(r) => r.s.id}
              onRowClick={(r) => setParam('open', r.s.id)}
              selectedKey={openId}
              initialSort={{ key: 'spend', dir: 'desc' }}
              empty={<div className="empty">No services match the filters or search.</div>}
              columns={[
                { key: 'n', header: 'Service · provider', width: 250, render: (r) => <span>{r.s.name}<span className="sub">{r.s.provider} · <span className="mono">{r.s.id}</span>{r.s.keys.length ? ` · ${r.s.keys.length} key${r.s.keys.length > 1 ? 's' : ''}` : ''}</span></span>, sort: (r) => r.s.name },
                { key: 'c', header: 'Category · billing', render: (r) => <span className="small nowrap"><i style={{ width: 8, height: 8, borderRadius: 2, background: CATEGORY_COLORS[r.s.category], display: 'inline-block', marginRight: 5 }} />{r.s.category === 'cloud' ? SUBTYPE_LABEL[r.s.subType] : CATEGORY_LABEL[r.s.category]}<span className="sub">{BILLING_LABEL[r.s.billing]}</span></span>, sort: (r) => `${r.s.category}${r.s.subType}` },
                ...(showOwners ? [{ key: 'o', header: 'Owner', render: (r: ServiceRow) => <span className="small nowrap">{userName(r.s.ownerUserId)}</span>, sort: (r: ServiceRow) => userName(r.s.ownerUserId) }] : []),
                { key: 'd', header: 'Department', render: (r) => (r.s.deptId ? <span className="small">{deptName(r.s.deptId)}</span> : <span className="chip warn dashed">Unallocated</span>), sort: (r) => deptName(r.s.deptId) },
                { key: 'cap', header: 'Paid capacity / mo', num: true, render: (r) => (r.st.avgCapacity !== null ? formatQty(r.st.avgCapacity, r.s.unit) : <span className="muted small" title={r.s.quota ? `Monthly limit ${formatQty(r.s.quota, r.s.unit)}` : undefined}>Pay-as-you-go</span>) },
                { key: 'u', header: 'Actual use / mo', num: true, render: (r) => formatQty(r.st.avgUsage, r.s.unit), sort: (r) => r.st.avgUsage },
                { key: 'util', header: 'Utilisation', render: (r) => (r.st.util === null ? <span className="muted small nowrap">n/a · PAYG</span> : <span className="row" style={{ gap: 6 }}><MiniBar value={r.st.util} /><span className="mono small">{pct(r.st.util)}</span></span>), sort: (r) => r.st.util ?? 2 },
                { key: 'spend', header: `Spend (${filters.months} m)`, num: true, render: (r) => inrShort(r.st.spend), sort: (r) => r.st.spend },
                { key: 'idle', header: 'Idle', num: true, render: (r) => (r.st.idle > 1 ? inrShort(r.st.idle) : <span className="muted">—</span>), sort: (r) => r.st.idle },
                { key: 'r', header: 'Renewal', render: (r) => (r.s.renewalDate ? <span className="nowrap small">{fmtDate(r.s.renewalDate)}</span> : <span className="muted small">Rolling</span>), sort: (r) => r.s.renewalDate ?? '9999' },
              ]}
              footer={
                <tr>
                  <td colSpan={showOwners ? 7 : 6}>Total · {shown.length} services</td>
                  <td className="num">{inrShort(shown.reduce((a, r) => a + r.st.spend, 0))}</td>
                  <td className="num">{inrShort(shown.reduce((a, r) => a + r.st.idle, 0))}</td>
                  <td />
                </tr>
              }
            />
          </Panel>
          <div className="section-gap">
            <Panel flush title="API keys" sub="Masked identifiers only · the secret is never stored or displayed">
              <DataTable
                rows={keys}
                rowKey={(k) => k.key.id}
                onRowClick={(k) => setParam('open', k.service.id)}
                initialSort={{ key: 'last', dir: 'desc' }}
                pageSize={10}
                columns={[
                  { key: 'k', header: 'Key', render: (k) => <span><span className="mono">{k.key.masked}</span><span className="sub">{k.key.label}</span></span>, sort: (k) => k.key.masked },
                  { key: 's', header: 'Service', render: (k) => <span className="small">{k.service.name}</span>, sort: (k) => k.service.name },
                  { key: 'e', header: 'Env', render: (k) => <span className="small">{k.key.environment}</span> },
                  ...(showOwners ? [{ key: 'o', header: 'Owner', render: (k: (typeof keys)[number]) => <span className="small">{userName(k.key.ownerUserId)}</span>, sort: (k: (typeof keys)[number]) => userName(k.key.ownerUserId) }] : []),
                  { key: 'c', header: 'Created', render: (k) => <span className="nowrap small">{fmtDate(k.key.created)}</span>, sort: (k) => k.key.created },
                  { key: 'last', header: 'Last used', render: (k) => (k.daysSinceUse >= RARE_KEY_DAYS ? <StatusChip status="underused">{k.daysSinceUse} days ago</StatusChip> : <span className="nowrap small">{fmtDate(k.key.lastUsed)}</span>), sort: (k) => k.daysSinceUse },
                  { key: 'x', header: 'Expires', render: (k) => <span className="nowrap small">{k.key.expires ? fmtDate(k.key.expires) : 'No expiry'}</span>, sort: (k) => k.key.expires ?? '9999' },
                  { key: 'n', header: 'Calls (30 d)', num: true, render: (k) => num(k.key.calls30d), sort: (k) => k.key.calls30d },
                ]}
              />
            </Panel>
          </div>
        </>
      )}

      {view === 'owners' && showOwners && (
        <Panel flush title="Owner view" sub={`Who holds each service and key · spend annualised from the last ${filters.months} months`}>
          <DataTable
            rows={owners}
            rowKey={(o) => o.ownerUserId}
            onRowClick={(o) => {
              setQ(userName(o.ownerUserId));
              setParam('view', null);
            }}
            initialSort={{ key: 'sp', dir: 'desc' }}
            columns={[
              { key: 'n', header: 'Owner', render: (o) => { const u = ds.users.find((x) => x.id === o.ownerUserId); return <span>{u?.name}<span className="sub">{u?.title}</span></span>; }, sort: (o) => userName(o.ownerUserId) },
              { key: 'd', header: 'Departments charged', render: (o) => <span className="small">{o.depts.map(deptName).join(', ')}</span> },
              { key: 's', header: 'Services', num: true, render: (o) => o.services, sort: (o) => o.services },
              { key: 'k', header: 'Keys', num: true, render: (o) => o.keys, sort: (o) => o.keys },
              { key: 'rk', header: 'Rarely used keys', num: true, render: (o) => (o.rareKeys ? <span className="text-warn">{o.rareKeys}</span> : <span className="muted">0</span>), sort: (o) => o.rareKeys },
              { key: 'sp', header: 'Annual spend', num: true, render: (o) => inrShort(o.spend), sort: (o) => o.spend },
              { key: 'i', header: 'Idle spend', num: true, render: (o) => (o.idle > 1 ? inrShort(o.idle) : <span className="muted">—</span>), sort: (o) => o.idle },
              { key: 'q', header: 'Limit hits', num: true, render: (o) => o.quotaHits, sort: (o) => o.quotaHits },
            ]}
          />
          <p className="small muted" style={{ padding: '8px 14px' }}>Click an owner to list their services and keys in the Service / Key view.</p>
        </Panel>
      )}

      <SectionLabel>Where paid capacity sits idle</SectionLabel>
      <div className="grid-2">
        <Panel id="svc-idle" flush title="Idle services" sub={`Paid capacity under 40% used · last ${filters.months} months`} footer={<span className="takeaway">Pay-as-you-go services never appear here: they are billed only for what is used.</span>}>
          <DataTable
            rows={idle}
            rowKey={(r) => r.s.id}
            onRowClick={(r) => setParam('open', r.s.id)}
            empty={<div className="empty">No paid capacity under 40% used.</div>}
            columns={[
              { key: 'n', header: 'Service', render: (r) => <span>{r.s.name}<span className="sub">{BILLING_LABEL[r.s.billing]} · {deptName(r.s.deptId)}</span></span> },
              { key: 'u', header: 'Used', render: (r) => <span className="row" style={{ gap: 6 }}><MiniBar value={r.st.util ?? 0} /><span className="mono small">{pct(r.st.util ?? 0)}</span></span> },
              { key: 'i', header: 'Idle spend', num: true, render: (r) => inrShort(r.st.idle) },
            ]}
          />
        </Panel>
        <Panel id="svc-unused" flush title="Unused cloud resources" sub="Under 15% busy in the latest three months · stopped VMs, unattached disks, idle GPUs" footer={<span className="takeaway">Provisioned cloud is billed while it exists, busy or not.</span>}>
          <DataTable
            rows={unused}
            rowKey={(r) => r.s.id}
            onRowClick={(r) => setParam('open', r.s.id)}
            empty={<div className="empty">No cloud resource under 15% busy.</div>}
            columns={[
              { key: 'n', header: 'Resource', render: (r) => <span>{r.s.name}<span className="sub">{SUBTYPE_LABEL[r.s.subType]} · {r.s.provider}</span></span> },
              { key: 'u', header: 'Busy', num: true, render: (r) => pct(r.recentUtil) },
              { key: 'm', header: 'Billed / month', num: true, render: (r) => inrShort(r.st.spend / 3) },
              { key: 'i', header: 'Idle / month', num: true, render: (r) => inrShort(r.monthlyIdle) },
            ]}
          />
        </Panel>
      </div>

      <SectionLabel>Keys, limits and spend</SectionLabel>
      <div className="grid-3-even">
        <Panel id="svc-keys" flush title="Rarely used keys" sub={`No calls for ${RARE_KEY_DAYS}+ days, or under 50 in 30 days`}>
          <DataTable
            rows={rareKeys}
            rowKey={(k) => k.key.id}
            onRowClick={(k) => setParam('open', k.service.id)}
            empty={<div className="empty">Every key is in regular use.</div>}
            columns={[
              { key: 'k', header: 'Key', render: (k) => <span><span className="mono">{k.key.masked}</span><span className="sub">{k.key.label}{showOwners ? ` · ${userName(k.key.ownerUserId)}` : ''}</span></span> },
              { key: 'd', header: 'Last used', num: true, render: (k) => `${k.daysSinceUse} d` },
            ]}
          />
        </Panel>
        <Panel id="svc-limits" flush title="Quota and limit hits" sub={`Requests refused by quotas, rate or instance limits · last ${filters.months} months`}>
          <DataTable
            rows={limits}
            rowKey={(r) => r.s.id}
            onRowClick={(r) => setParam('open', r.s.id)}
            empty={<div className="empty">No limit hits in this period.</div>}
            columns={[
              { key: 'n', header: 'Service', render: (r) => <span>{r.s.name.split(' — ')[0]}<span className="sub">{r.s.quota ? `limit ${formatQty(r.s.quota, r.s.unit)}/mo` : r.s.capacity ? `capacity ${formatQty(r.s.capacity, r.s.unit)}/mo` : ''}</span></span> },
              { key: 'h', header: 'Hits', num: true, render: (r) => r.st.quotaHits },
              { key: 'b', header: 'Blocked', num: true, render: (r) => hours(r.st.blockedHours) },
            ]}
          />
        </Panel>
        <Panel id="svc-outliers" flush title="Spend outliers" sub="A month at 1.5× or more of its previous six-month median">
          <DataTable
            rows={outliers}
            rowKey={(o) => `${o.service.id}-${o.month}`}
            onRowClick={(o) => setParam('open', o.service.id)}
            empty={<div className="empty">No unusual months in this period.</div>}
            columns={[
              { key: 'n', header: 'Service · month', render: (o) => <span>{o.service.name.split(' — ')[0]}<span className="sub">{monthLabel(o.month, true)} · usual {inrShort(o.baseline)}</span></span> },
              { key: 's', header: 'Spend', num: true, render: (o) => inrShort(o.spend) },
              { key: 'x', header: '×', num: true, render: (o) => <span className="text-warn">{o.ratio.toFixed(1)}×</span> },
            ]}
          />
        </Panel>
      </div>

      <SectionLabel>Renewals and history</SectionLabel>
      <div className="grid-2-wide">
        <Panel
          id="svc-trend"
          title="12-month history"
          sub="Monthly spend by category (₹ lakh) and utilisation of paid capacity"
          actions={
            <div className="legend">
              <span><i style={{ background: CATEGORY_COLORS.cloud }} />Cloud</span>
              <span><i style={{ background: CATEGORY_COLORS.ai }} />AI tokens</span>
              <span><i style={{ background: CATEGORY_COLORS.api }} />API services</span>
              <span><i style={{ background: 'var(--copper)', height: 2 }} />Utilisation</span>
            </div>
          }
          footer={<span className="takeaway">Simulated billing history (sample data). Hover a month for idle spend and blocked hours.</span>}
        >
          <ServiceTrendChart data={trend} height={300} />
        </Panel>
        <Panel id="svc-renewals" flush title="Upcoming renewals and expiries" sub={`Next ${RENEWAL_WINDOW_DAYS} days · commitments, reservations and API keys`}>
          <DataTable
            rows={renewalRows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setParam('open', r.sid)}
            empty={<div className="empty">Nothing renews or expires in the next {RENEWAL_WINDOW_DAYS} days.</div>}
            columns={[
              { key: 'n', header: 'Item', render: (r) => <span className={r.label.includes('••••') ? 'mono' : undefined}>{r.label}<span className="sub" style={{ fontFamily: 'var(--font-sans)' }}>{r.what}</span></span> },
              { key: 'd', header: 'Date', render: (r) => (r.days <= 45 ? <StatusChip status="renewal-soon">{fmtDate(r.date)} · {r.days} d</StatusChip> : <span className="nowrap small">{fmtDate(r.date)} · {r.days} d</span>) },
              { key: 'v', header: 'Annual value', num: true, render: (r) => (r.value ? inrShort(r.value) : <span className="muted">—</span>) },
            ]}
          />
        </Panel>
      </div>

      <p className="small muted" style={{ marginTop: 14 }}>
        Tracking only: figures are measured or simulated history from sample billing exports and usage logs. This module does not forecast demand, optimise purchases or recommend actions. API keys are shown as masked identifiers; no secret is stored.
      </p>

      {openSvc && <ServiceDrawer s={openSvc} months={filters.months} showOwners={showOwners} onClose={() => setParam('open', null)} />}
    </>
  );
}

