import { KeyRound, ShieldCheck } from 'lucide-react';
import { BASIS_RULE, BILLING_LABEL, CATEGORY_LABEL, formatQty, RARE_KEY_DAYS, servicePeriod, statsFor, SUBTYPE_LABEL } from '../../calc/services';
import { ServiceHistoryBars } from '../../components/charts/ServiceCharts';
import { Drawer } from '../../components/ui/Overlay';
import { Callout, MiniBar } from '../../components/ui/basics';
import { StatusChip } from '../../components/ui/StatusChip';
import type { ServiceRecord } from '../../domain/types';
import { daysBetween, DEMO_TODAY, fmtDate, monthLabel } from '../../lib/dates';
import { hours, inr, inrShort, num, pct } from '../../lib/format';
import { useApp } from '../../state/store';

export function ServiceDrawer({ s, months, showOwners, onClose }: { s: ServiceRecord; months: number; showOwners: boolean; onClose: () => void }) {
  const { ds } = useApp();
  const period = servicePeriod(months);
  const st = statsFor(s, period);
  const last12 = s.months.slice(-12);
  const owner = ds.users.find((u) => u.id === s.ownerUserId);
  const dept = s.deptId ? ds.departments.find((d) => d.id === s.deptId)?.name : 'Unallocated';
  const userName = (id: string) => ds.users.find((u) => u.id === id)?.name ?? id;

  return (
    <Drawer wide eyebrow={`${s.id} · ${CATEGORY_LABEL[s.category]} · ${SUBTYPE_LABEL[s.subType]}`} title={s.name} onClose={onClose} aside={<div className="row small muted" style={{ marginTop: 6 }}>{s.provider} · {dept}{showOwners && owner ? ` · owner ${owner.name}` : ''}</div>}>
      <table className="statement">
        <tbody>
          <tr>
            <td>Billing type</td>
            <td className="num">{BILLING_LABEL[s.billing]}</td>
          </tr>
          <tr>
            <td>Paid capacity</td>
            <td className="num">{s.capacity !== null ? `${formatQty(s.capacity, s.unit)} / month · ${inrShort(s.fixedMonthly)}` : s.quota ? `None — pay per use (limit ${formatQty(s.quota, s.unit)}/month)` : 'None — pay per use'}</td>
          </tr>
          {s.basis !== 'commitment' || s.unitPrice > 0 ? (
            <tr>
              <td>{s.basis === 'consumption' ? 'Unit price' : s.basis === 'commitment' ? 'Overage price above the commitment' : 'Billing'}</td>
              <td className="num">{s.basis === 'provisioned' ? 'Per hour / size provisioned' : `${inr(s.unitPrice)} per ${s.unit.replace(/^k /, '1,000 ').replace(/^M /, '1 million ')}`}</td>
            </tr>
          ) : null}
          <tr>
            <td>Average monthly use · last {months} months</td>
            <td className="num">{formatQty(st.avgUsage, s.unit)}</td>
          </tr>
          <tr>
            <td>Utilisation of paid capacity</td>
            <td className="num">{st.util === null ? <span className="muted">Not applicable (pay-as-you-go)</span> : <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}><MiniBar value={st.util} /> {pct(st.util)}</span>}</td>
          </tr>
          <tr className="total">
            <td>Spend · last {months} months</td>
            <td className="num">{inrShort(st.spend)}</td>
          </tr>
          <tr>
            <td>of which idle capacity</td>
            <td className="num">{inrShort(st.idle)}</td>
          </tr>
          {st.meteredSpend > 1 && (
            <tr>
              <td>of which pay-as-you-go / overage</td>
              <td className="num">{inrShort(st.meteredSpend)}</td>
            </tr>
          )}
          <tr>
            <td>Quota / limit hits · engineer-hours blocked</td>
            <td className="num">
              {num(st.quotaHits)} · {hours(st.blockedHours)}
            </td>
          </tr>
          <tr>
            <td>{s.renewalKind ? s.renewalKind[0].toUpperCase() + s.renewalKind.slice(1) : 'Renewal'}</td>
            <td className="num">{s.renewalDate ? `${fmtDate(s.renewalDate, 'long')} · ${daysBetween(DEMO_TODAY, s.renewalDate)} days` : 'Rolling, no end date'}</td>
          </tr>
        </tbody>
      </table>

      <div className="block">
        <h3>How idle spend is judged</h3>
        <p className="small">{BASIS_RULE[s.basis]}</p>
        {s.note && <p className="small muted">{s.note}</p>}
      </div>

      <div className="block">
        <h3>Last 12 months</h3>
        <ServiceHistoryBars months={last12} />
        <table className="table table-compact" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Use</th>
              <th className="num">Capacity</th>
              <th className="num">Spend</th>
              <th className="num">Idle</th>
              <th className="num">Limit hits</th>
              <th className="num">Blocked</th>
            </tr>
          </thead>
          <tbody>
            {[...last12].reverse().map((m) => (
              <tr key={m.month}>
                <td>{monthLabel(m.month, true)}</td>
                <td className="num">{formatQty(m.usage, s.unit)}</td>
                <td className="num">{m.capacity === null ? <span className="muted">PAYG</span> : formatQty(m.capacity, s.unit)}</td>
                <td className="num">{inr(m.spend)}</td>
                <td className="num">{m.idle > 0.5 ? inr(m.idle) : <span className="muted">—</span>}</td>
                <td className="num">{m.quotaHits || <span className="muted">0</span>}</td>
                <td className="num">{m.blockedHours ? hours(m.blockedHours) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="block">
        <h3>API keys</h3>
        {s.keys.length ? (
          <>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Env</th>
                  {showOwners && <th>Owner</th>}
                  <th>Last used</th>
                  <th>Expires</th>
                  <th className="num">Calls (30 d)</th>
                </tr>
              </thead>
              <tbody>
                {s.keys.map((k) => {
                  const d = daysBetween(k.lastUsed, DEMO_TODAY);
                  return (
                    <tr key={k.id}>
                      <td>
                        <span className="mono">
                          <KeyRound style={{ width: 12, height: 12, verticalAlign: -1 }} aria-hidden /> {k.masked}
                        </span>
                        <span className="sub">{k.label}</span>
                      </td>
                      <td className="small">{k.environment}</td>
                      {showOwners && <td className="small">{userName(k.ownerUserId)}</td>}
                      <td className="nowrap">{d >= RARE_KEY_DAYS ? <StatusChip status="underused">{fmtDate(k.lastUsed)} · {d} d</StatusChip> : fmtDate(k.lastUsed)}</td>
                      <td className="nowrap small">{k.expires ? fmtDate(k.expires) : 'No expiry'}</td>
                      <td className="num">{num(k.calls30d)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ marginTop: 8 }}>
              <Callout icon={ShieldCheck}>Only a masked identifier and the last four characters are held. Secrets stay in the company vault and are never stored or shown here.</Callout>
            </div>
          </>
        ) : (
          <p className="small muted">No API keys — access is through the cloud account’s managed identity.</p>
        )}
      </div>
      <p className="small muted block">Simulated billing and usage history (sample data). Tracking only — this module records what was used and billed; it does not forecast or recommend.</p>
    </Drawer>
  );
}
