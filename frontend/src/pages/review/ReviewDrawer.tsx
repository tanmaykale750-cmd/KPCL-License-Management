import { BadgeCheck, Ban, CheckCheck, FileText } from 'lucide-react';
import { useState } from 'react';
import { bridgeFor, priceVolume, verifiedSaving } from '../../calc/review';
import { BridgeChart } from '../../components/charts/BridgeChart';
import { Drawer } from '../../components/ui/Overlay';
import { Callout, Field, MiniBar } from '../../components/ui/basics';
import type { ReviewRecord } from '../../domain/types';
import { DEMO_TODAY, fmtDate, fmtDateTime } from '../../lib/dates';
import { inr, inrShort, num } from '../../lib/format';
import { useApp } from '../../state/store';
import { outcomeChip, KIND_LABEL } from './outcome';

function Calc({ r }: { r: ReviewRecord }) {
  const b = bridgeFor(r);
  if (r.state === 'verified-cost-avoided') {
    return (
      <pre className="calc">
        {`Purchase avoided   = ${r.qtyApproved - r.qtyBefore} seats × ${inr(r.priceBefore)}
                   = ${inr(r.costAvoided ?? 0)}
Evidence           = vendor confirmation, no PO for extra seats
Verified saving    = cost avoided = ${inrShort(r.costAvoided ?? 0)}`}
      </pre>
    );
  }
  if (r.state === 'partly-verified') {
    return (
      <pre className="calc">
        {`Baseline spend     = ${inr(r.baselineSpend)}
Recorded spend     = ${inr(r.recordedSpend ?? 0)}
Verified saving    = baseline − recorded = ${inrShort(verifiedSaving(r))}
Approved           = ${inrShort(r.approvedValue)} (difference stays unverified)`}
      </pre>
    );
  }
  if (!b) return <p className="small muted">Calculation appears once invoice evidence is attached.</p>;
  return (
    <pre className="calc">
      {`Volume effect  = (q_new − q_old) × p_old = (${r.qtyAfter} − ${r.qtyBefore}) × ${inr(r.priceBefore)} = ${inrShort(b.volume, { sign: true })}
Price effect   = (p_new − p_old) × q_new = (${inr(r.priceAfter!)} − ${inr(r.priceBefore)}) × ${r.qtyAfter} = ${inrShort(b.price, { sign: true })}
Invoice change = ${inrShort(b.invoiceChange, { sign: true })}
Verified saving = volume effect only = ${inrShort(verifiedSaving(r))}`}
    </pre>
  );
}

export function ReviewDrawer({ r, onClose }: { r: ReviewRecord; onClose: () => void }) {
  const { ds, state, perms, actions, me } = useApp();
  const lic = ds.licences.find((l) => l.id === r.licenceId);
  const lines = state.invoices.filter((l) => r.invoiceLineIds.includes(l.id));
  const b = bridgeFor(r);
  const fin = state.finance[0];
  const [po, setPo] = useState(r.poRef ?? '');
  const [qty, setQty] = useState(r.qtyApproved);
  const [reason, setReason] = useState('');
  const [notMode, setNotMode] = useState(false);
  const [inv, setInv] = useState({ invoiceNo: '', date: DEMO_TODAY, quantity: r.qtyAfter ?? r.qtyApproved, unitPrice: r.priceBefore });
  const [ref, setRef] = useState('');
  const [err, setErr] = useState('');

  const canImplement = perms.prepareReview && r.state === 'awaiting-implementation';
  const canVerify = perms.verifySavings && r.state === 'awaiting-invoice';
  const selfCheck = canVerify && r.history.some((h) => h.action === 'Marked implemented' && h.actor === me.name);
  const preview = canVerify && r.kind !== 'reallocation' && inv.unitPrice > 0 ? priceVolume(r.qtyBefore, r.priceBefore, inv.quantity, inv.unitPrice) : null;

  const implement = () => {
    if (!/^PO-\d{6,}$/.test(po.trim())) return setErr('Enter the purchase order reference (PO- followed by at least 6 digits).');
    setErr('');
    actions.markImplemented(r.id, po.trim(), qty);
  };
  const notImplemented = () => {
    if (reason.trim().length < 10) return setErr('Give the reason in at least 10 characters — it feeds the next planning cycle.');
    setErr('');
    actions.recordNotImplemented(r.id, reason.trim());
    setNotMode(false);
  };
  const verify = () => {
    if (r.kind === 'reallocation') {
      if (ref.trim().length < 4) return setErr('Enter the vendor confirmation or change reference.');
      setErr('');
      return actions.verifyCostAvoided(r.id, ref.trim(), reason.trim());
    }
    if (!inv.invoiceNo.trim()) return setErr('Enter the invoice number from the vendor invoice.');
    if (inv.quantity < 0 || inv.unitPrice <= 0) return setErr('Quantity must be 0 or more and unit price above zero.');
    setErr('');
    actions.attachInvoiceAndVerify(r.id, { invoiceNo: inv.invoiceNo.trim(), poRef: r.poRef ?? po, vendorId: lic?.vendorId ?? '', licenceId: r.licenceId, date: inv.date, quantity: inv.quantity, unitPrice: inv.unitPrice, description: `${lic?.product ?? r.licenceId} — ${r.cycle}` });
  };

  const footer = canImplement ? (
    notMode ? (
      <>
        <button className="btn" onClick={() => setNotMode(false)}>
          Back
        </button>
        <button className="btn danger" onClick={notImplemented}>
          <Ban /> Record not implemented
        </button>
      </>
    ) : (
      <>
        <button className="btn" onClick={() => setNotMode(true)}>
          <Ban /> Not implemented…
        </button>
        <button className="btn primary" onClick={implement}>
          <CheckCheck /> Mark implemented
        </button>
      </>
    )
  ) : canVerify && !selfCheck ? (
    <button className="btn primary" onClick={verify}>
      <BadgeCheck /> {r.kind === 'reallocation' ? 'Verify as cost avoided' : 'Attach invoice and verify'}
    </button>
  ) : undefined;

  return (
    <Drawer wide eyebrow={`${r.id} · ${r.cycle} · ${KIND_LABEL[r.kind]}`} title={r.title} onClose={onClose} aside={<div className="row" style={{ marginTop: 8 }}>{outcomeChip(r)}</div>} footer={footer}>
      <table className="statement">
        <tbody>
          <tr>
            <td>Approved value (a year)</td>
            <td className="num est">{inrShort(r.approvedValue)}</td>
          </tr>
          <tr>
            <td>Quantity: before → approved → invoiced</td>
            <td className="num">
              {r.qtyBefore} → {r.qtyApproved} → {r.qtyAfter ?? '—'}
            </td>
          </tr>
          <tr>
            <td>Baseline spend (last cycle invoice)</td>
            <td className="num">{inrShort(r.baselineSpend)}</td>
          </tr>
          <tr>
            <td>Expected spend</td>
            <td className="num est">{inrShort(r.expectedSpend)}</td>
          </tr>
          <tr>
            <td>Recorded spend (this cycle invoice)</td>
            <td className="num">{r.recordedSpend !== undefined ? inrShort(r.recordedSpend) : '—'}</td>
          </tr>
          <tr className="verified">
            <td>Verified saving</td>
            <td className="num">{inrShort(verifiedSaving(r))}</td>
          </tr>
        </tbody>
      </table>

      {b && (
        <div className="block">
          <h3>Invoice bridge</h3>
          <BridgeChart b={b} height={190} />
          <p className="small muted">Teal = volume effect (credited). Hatched copper = vendor price change (not credited, not a saving).</p>
        </div>
      )}

      <div className="block">
        <h3>Calculation</h3>
        <Calc r={r} />
      </div>

      <div className="block">
        <h3>Evidence</h3>
        {lines.length ? (
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Invoice · PO</th>
                <th>Date</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Line total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="mono">
                      <FileText style={{ width: 12, height: 12, verticalAlign: -1 }} /> {l.invoiceNo}
                    </span>
                    <span className="sub">
                      {l.poRef} · {l.description}
                    </span>
                  </td>
                  <td className="nowrap">{fmtDate(l.date)}</td>
                  <td className="num">{l.quantity}</td>
                  <td className="num">{inr(l.unitPrice)}</td>
                  <td className="num">{inr(l.quantity * l.unitPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="small muted">No invoice lines attached yet.{r.poRef ? ` Purchase order ${r.poRef}.` : ''}</p>
        )}
        <p className="small muted" style={{ marginTop: 6 }}>
          Invoice lines are sample records entered in this prototype. In production they come from the ERP purchase-order and invoice tables.
        </p>
      </div>

      <div className="block">
        <h3>Shortages after the change</h3>
        {r.shortagesAfter ? (
          <table className="statement">
            <tbody>
              <tr>
                <td>Blocked hours measured since the change</td>
                <td className="num">
                  {num(r.shortagesAfter.blockedHours)} h of {r.shortagesAfter.limitHours} h limit <MiniBar value={r.shortagesAfter.blockedHours} max={r.shortagesAfter.limitHours} />
                </td>
              </tr>
              <tr>
                <td>Denied requests</td>
                <td className="num">{r.shortagesAfter.denials}</td>
              </tr>
              <tr>
                <td>Estimated at approval</td>
                <td className="num est">{r.estBlockedHours} h</td>
              </tr>
              {perms.seesCosts && (
                <tr>
                  <td>Cost of blocked time since ({fin.version})</td>
                  <td className="num est">{inrShort(r.shortagesAfter.blockedHours * fin.loadedHourlyCost * fin.productivityLoss)}</td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <p className="small muted">{r.state === 'not-implemented' ? 'Not implemented — nothing to monitor.' : 'Monitoring starts when the change is implemented. Blocked hours are compared with the estimate at approval.'}</p>
        )}
      </div>

      {r.notImplementedReason && (
        <div className="block">
          <Callout tone="warn">
            <b>Not implemented:</b> {r.notImplementedReason}
          </Callout>
        </div>
      )}

      {canImplement && (
        <div className="block">
          <h3>{notMode ? 'Why was it not implemented?' : 'Record implementation'}</h3>
          {notMode ? (
            <Field label="Reason" htmlFor="rv-reason" error={err || undefined} full>
              <textarea id="rv-reason" className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Department kept seats for an unplanned customer project" />
            </Field>
          ) : (
            <div className="form-grid">
              <Field label="Purchase order" htmlFor="rv-po" error={err || undefined}>
                <input id="rv-po" className="input mono" value={po} onChange={(e) => setPo(e.target.value)} placeholder="PO-4500…" />
              </Field>
              <Field label="Quantity after the change" htmlFor="rv-qty">
                <input id="rv-qty" type="number" className="input" value={qty} min={0} onChange={(e) => setQty(Number(e.target.value))} />
              </Field>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 6 }}>Savings stay “approved” until Finance verifies them against an invoice.</p>
        </div>
      )}

      {canVerify && (
        <div className="block">
          <h3>{r.kind === 'reallocation' ? 'Verify cost avoided' : 'Attach invoice evidence'}</h3>
          {selfCheck ? (
            <Callout tone="warn">You recorded the implementation, so another person must verify it.</Callout>
          ) : r.kind === 'reallocation' ? (
            <div className="form-grid">
              <Field label="Vendor confirmation / change ref" htmlFor="rv-ref" error={err || undefined}>
                <input id="rv-ref" className="input mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="ANS-RH-…" />
              </Field>
              <Field label="Note (optional)" htmlFor="rv-note">
                <input id="rv-note" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </div>
          ) : (
            <>
              <div className="form-grid">
                <Field label="Invoice number" htmlFor="rv-inv" error={err || undefined}>
                  <input id="rv-inv" className="input mono" value={inv.invoiceNo} onChange={(e) => setInv({ ...inv, invoiceNo: e.target.value })} placeholder="INV-…" />
                </Field>
                <Field label="Invoice date" htmlFor="rv-date">
                  <input id="rv-date" type="date" className="input" value={inv.date} onChange={(e) => setInv({ ...inv, date: e.target.value })} />
                </Field>
                <Field label="Quantity invoiced" htmlFor="rv-iq">
                  <input id="rv-iq" type="number" className="input" min={0} value={inv.quantity} onChange={(e) => setInv({ ...inv, quantity: Number(e.target.value) })} />
                </Field>
                <Field label="Unit price (₹)" htmlFor="rv-ip">
                  <input id="rv-ip" type="number" className="input" min={0} value={inv.unitPrice} onChange={(e) => setInv({ ...inv, unitPrice: Number(e.target.value) })} />
                </Field>
              </div>
              {preview && (
                <div style={{ marginTop: 10 }}>
                  <div className="label-caps">Preview before saving</div>
                  <BridgeChart b={preview} height={160} compact />
                  <p className="small">
                    Saving that would be verified: <b>{inrShort(Math.max(0, -preview.volume))}</b>
                    {inv.quantity !== r.qtyApproved ? ` — partly verified (${inv.quantity} invoiced vs ${r.qtyApproved} approved)` : ''}.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="block">
        <h3>History</h3>
        <ul className="timeline-list">
          {r.history.map((h, i) => (
            <li key={i}>
              <span className="when">{fmtDateTime(h.at)}</span> <b style={{ fontWeight: 600 }}>{h.action}</b> · {h.actor}
              {h.note && <div className="small muted">{h.note}</div>}
            </li>
          ))}
        </ul>
      </div>
    </Drawer>
  );
}
