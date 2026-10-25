import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { renewalAdvice } from '../../calc/plan';
import { DataTable } from '../../components/ui/DataTable';
import { Drawer } from '../../components/ui/Overlay';
import { StatusChip } from '../../components/ui/StatusChip';
import { PageHead, Panel } from '../../components/ui/basics';
import { daysBetween, DEMO_TODAY, fmtDate } from '../../lib/dates';
import { inr, inrShort } from '../../lib/format';
import { useApp } from '../../state/store';

export default function VendorsPage() {
  const { ds, state, perms } = useApp();
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const setOpen = (id: string | null) => {
    const n = new URLSearchParams(params);
    if (id) n.set('open', id);
    else n.delete('open');
    setParams(n, { replace: true });
  };

  const rows = useMemo(
    () =>
      ds.vendors.map((v) => {
        const lics = ds.licences.filter((l) => l.vendorId === v.id);
        const spend = lics.reduce((a, l) => a + l.seats * l.costPerSeat, 0);
        const next = [...lics].sort((a, b) => a.renewalDate.localeCompare(b.renewalDate)).find((l) => l.renewalDate >= DEMO_TODAY);
        const potential = lics.reduce((a, l) => a + renewalAdvice(ds, l.id).annualSaving, 0);
        const invoices = state.invoices.filter((i) => i.vendorId === v.id);
        return { v, lics, spend, next, potential, invoices };
      }),
    [ds, state.invoices],
  );
  const open = rows.find((r) => r.v.id === openId);

  return (
    <>
      <PageHead title="Vendors" sub="Contracts, spend and renewal timing by vendor." />
      <Panel flush>
        <DataTable
          rows={rows}
          rowKey={(r) => r.v.id}
          onRowClick={(r) => setOpen(r.v.id)}
          selectedKey={openId}
          initialSort={{ key: 's', dir: 'desc' }}
          columns={[
            { key: 'n', header: 'Vendor', render: (r) => <span>{r.v.name}<span className="sub">{r.v.accountManager}</span></span>, sort: (r) => r.v.name },
            { key: 'l', header: 'Products', render: (r) => <span className="small">{[...new Set(r.lics.map((l) => l.product))].join(', ')}</span> },
            { key: 'c', header: 'Pools', num: true, render: (r) => r.lics.length, sort: (r) => r.lics.length },
            ...(perms.seesCosts ? [{ key: 's', header: 'Annual spend', num: true, render: (r: (typeof rows)[number]) => inrShort(r.spend), sort: (r: (typeof rows)[number]) => r.spend }] : []),
            { key: 'r', header: 'Next renewal', render: (r) => (r.next ? (daysBetween(DEMO_TODAY, r.next.renewalDate) <= 90 ? <StatusChip status="renewal-soon">{fmtDate(r.next.renewalDate)} · {r.next.id}</StatusChip> : <span className="small nowrap">{fmtDate(r.next.renewalDate)} · {r.next.id}</span>) : '—'), sort: (r) => r.next?.renewalDate ?? '9999' },
            { key: 't', header: 'Payment terms', render: (r) => <span className="small">{r.v.paymentTerms}</span> },
            ...(perms.seesCosts ? [{ key: 'p', header: 'Renewal saving option', num: true, render: (r: (typeof rows)[number]) => (r.potential ? <span className="est">{inrShort(r.potential)}</span> : <span className="muted">—</span>), sort: (r: (typeof rows)[number]) => r.potential }] : []),
          ]}
        />
      </Panel>
      <p className="small muted">Vendor and contract details are sample records. Negotiation and payment are handled outside this tool.</p>

      {open && (
        <Drawer wide eyebrow="Vendor" title={open.v.name} onClose={() => setOpen(null)}>
          <dl className="dl">
            <dt>Account manager</dt>
            <dd>{open.v.accountManager}</dd>
            <dt>Payment terms</dt>
            <dd>{open.v.paymentTerms}</dd>
            {perms.seesCosts && (
              <>
                <dt>Annual spend</dt>
                <dd className="mono">{inrShort(open.spend)}</dd>
              </>
            )}
          </dl>
          <div className="block">
            <h3>Contracts</h3>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Product · contract</th>
                  <th className="num">Qty</th>
                  {perms.seesCosts && <th className="num">Unit / yr</th>}
                  <th>Renewal</th>
                  <th className="num">Notice</th>
                </tr>
              </thead>
              <tbody>
                {open.lics.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.product}
                      <span className="sub mono">
                        {l.contractRef} · {l.poRef}
                      </span>
                    </td>
                    <td className="num">
                      {l.seats} {l.unitLabel}
                    </td>
                    {perms.seesCosts && <td className="num">{inr(l.costPerSeat)}</td>}
                    <td className="nowrap">{fmtDate(l.renewalDate)}</td>
                    <td className="num">{l.noticeDays} d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {perms.seesCosts && (
            <div className="block">
              <h3>Invoice lines</h3>
              {open.invoices.length ? (
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Invoice · PO</th>
                      <th>Date</th>
                      <th className="num">Qty</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.invoices.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <span className="mono">{i.invoiceNo}</span>
                          <span className="sub">{i.description}</span>
                        </td>
                        <td className="nowrap">{fmtDate(i.date)}</td>
                        <td className="num">{i.quantity}</td>
                        <td className="num">{inr(i.quantity * i.unitPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="small muted">No invoice lines recorded.</p>
              )}
            </div>
          )}
        </Drawer>
      )}
    </>
  );
}
