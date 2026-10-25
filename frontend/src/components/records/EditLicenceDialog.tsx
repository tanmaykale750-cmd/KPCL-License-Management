import { useState } from 'react';
import type { Licence } from '../../domain/types';
import { useApp } from '../../state/store';
import { Field } from '../ui/basics';
import { Dialog } from '../ui/Overlay';

export function EditLicenceDialog({ licence, onClose }: { licence: Licence; onClose: () => void }) {
  const { actions } = useApp();
  const [f, setF] = useState({ status: licence.status, renewalDate: licence.renewalDate, noticeDays: String(licence.noticeDays), contractMinSeats: String(licence.contractMinSeats), server: licence.server, poRef: licence.poRef });
  const [reason, setReason] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => {
    const e: Record<string, string> = {};
    if (!f.renewalDate) e.renewalDate = 'Renewal date is required.';
    const nd = Number(f.noticeDays);
    if (!Number.isInteger(nd) || nd < 0 || nd > 365) e.noticeDays = '0–365 days.';
    const cm = Number(f.contractMinSeats);
    if (!Number.isInteger(cm) || cm < 0 || cm > licence.seats) e.contractMinSeats = `0–${licence.seats}.`;
    if (!/^PO-\d{6,}$/.test(f.poRef)) e.poRef = 'Format PO-4500012345.';
    if (reason.trim().length < 8) e.reason = 'Every change needs a reason (at least 8 characters).';
    setErrs(e);
    if (Object.keys(e).length) return;
    const patch: Partial<Licence> = {};
    if (f.status !== licence.status) patch.status = f.status;
    if (f.renewalDate !== licence.renewalDate) patch.renewalDate = f.renewalDate;
    if (nd !== licence.noticeDays) patch.noticeDays = nd;
    if (cm !== licence.contractMinSeats) patch.contractMinSeats = cm;
    if (f.server !== licence.server) patch.server = f.server;
    if (f.poRef !== licence.poRef) patch.poRef = f.poRef;
    if (!Object.keys(patch).length) {
      setErrs({ reason: 'Nothing changed.' });
      return;
    }
    actions.editLicence(licence.id, patch, reason.trim());
    onClose();
  };
  return (
    <Dialog
      title={`Edit ${licence.id}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save change
          </button>
        </>
      }
    >
      <p className="small muted" style={{ marginBottom: 12 }}>
        Seat counts change only through an approved recommendation or a purchase, so they are not editable here. Every change is written to the audit trail with old and new values.
      </p>
      <div className="form-grid">
        <Field label="Status" htmlFor="el-st">
          <select id="el-st" className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Licence['status'] })}>
            <option value="active">Active</option>
            <option value="renewal-due">Renewal due</option>
            <option value="under-review">Under review</option>
            <option value="retiring">Retiring at renewal</option>
          </select>
        </Field>
        <Field label="Renewal date" error={errs.renewalDate} htmlFor="el-rd">
          <input id="el-rd" type="date" className="input" value={f.renewalDate} onChange={(e) => setF({ ...f, renewalDate: e.target.value })} />
        </Field>
        <Field label="Notice period (days)" error={errs.noticeDays} htmlFor="el-nd">
          <input id="el-nd" type="number" className="input" value={f.noticeDays} onChange={(e) => setF({ ...f, noticeDays: e.target.value })} />
        </Field>
        <Field label="Contract minimum seats" error={errs.contractMinSeats} htmlFor="el-cm">
          <input id="el-cm" type="number" className="input" value={f.contractMinSeats} onChange={(e) => setF({ ...f, contractMinSeats: e.target.value })} />
        </Field>
        <Field label="Licence server" htmlFor="el-sv">
          <input id="el-sv" className="input mono" value={f.server} onChange={(e) => setF({ ...f, server: e.target.value })} />
        </Field>
        <Field label="Purchase order" error={errs.poRef} htmlFor="el-po">
          <input id="el-po" className="input mono" value={f.poRef} onChange={(e) => setF({ ...f, poRef: e.target.value })} />
        </Field>
        <Field label="Reason for change" error={errs.reason} full htmlFor="el-rs">
          <input id="el-rs" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Vendor confirmed new renewal date by email" />
        </Field>
      </div>
    </Dialog>
  );
}
