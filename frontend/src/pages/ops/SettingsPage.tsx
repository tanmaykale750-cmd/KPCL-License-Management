import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TEMP_PREMIUM, IDLE_RECOVERY_SHARE } from '../../calc/plan';
import { Dialog } from '../../components/ui/Overlay';
import { Callout, Field, PageHead, Panel } from '../../components/ui/basics';
import { fmtDate } from '../../lib/dates';
import { inrShort, num } from '../../lib/format';
import { DEFAULT_THRESHOLDS } from '../../state/seed';
import { useApp } from '../../state/store';

const INTEGRATIONS: { name: string; prod: string; here: string; status: 'mock' | 'sample' | 'none' }[] = [
  { name: 'Licence server logs', prod: 'FlexLM / RLM / DSLS usage and denial logs, collected daily', here: 'Deterministic generator: 104 weeks of weekly peaks and denials', status: 'mock' },
  { name: 'Spreadsheet imports', prod: 'Uploaded licence and usage files', here: 'Works in the browser: mapping, validation and commit to this session', status: 'sample' },
  { name: 'ERP purchase orders and invoices', prod: 'PO and invoice lines from the finance system', here: 'Sample invoice lines; new lines are typed in by Finance', status: 'sample' },
  { name: 'HR headcount plan', prod: 'Planned hires by department', here: 'Fixed growth factors in the sample catalogue', status: 'sample' },
  { name: 'Project registry', prod: 'PLM / project office phases and seat plans', here: 'Sample projects; changes follow the leader → head → admin workflow here', status: 'sample' },
  { name: 'Cloud billing exports', prod: 'Azure Cost Management, AWS Cost & Usage Report, GCP billing export — daily', here: 'Deterministic generator: 24 months of monthly spend for 26 sample services', status: 'mock' },
  { name: 'Cloud and AI usage telemetry', prod: 'VM/GPU/DB busy share, token and API-call counts, quota and rate-limit events', here: 'Simulated monthly usage and limit hits (Other Services)', status: 'mock' },
  { name: 'API key inventory', prod: 'Company secrets vault (key metadata only, never secrets)', here: 'Sample keys held as masked identifier + last four characters', status: 'sample' },
  { name: 'Single sign-on and roles', prod: 'Company SSO; role checks on every API call', here: 'Role switcher in the header, client-side only — not access control', status: 'none' },
  { name: 'Email / Teams notifications', prod: 'Alerts and approval requests sent to people', here: 'In-app notification list only', status: 'none' },
];

export default function SettingsPage() {
  const { state, perms, actions } = useApp();
  const [t, setT] = useState(state.thresholds);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const fin = state.finance[0];
  const dirty = JSON.stringify(t) !== JSON.stringify(state.thresholds);
  const canEdit = perms.editRegistry;

  const save = () => {
    if (t.shortageLeadWeeks < 1 || t.shortageLeadWeeks > 26) return setErr('Shortage lead time must be 1–26 weeks.');
    if (t.renewalWindowDays < 14 || t.renewalWindowDays > 365) return setErr('Renewal window must be 14–365 days.');
    if (t.denialLimit < 1 || t.denialLimit > 50) return setErr('Denial limit must be 1–50.');
    setErr('');
    actions.updateThresholds(t);
  };

  return (
    <>
      <PageHead title="Settings" sub="Alert thresholds, fixed planning assumptions and data sources." />
      <div className="settings-grid">
        <Panel
          title="Alert thresholds"
          sub={canEdit ? 'Used by the notification list for every role' : 'Set by the licence administrator'}
          footer={
            canEdit ? (
              <>
                <button className="btn" onClick={() => setT({ ...DEFAULT_THRESHOLDS })}>
                  Defaults
                </button>
                <span className="grow" />
                <button className="btn primary" disabled={!dirty} onClick={save}>
                  Save thresholds
                </button>
              </>
            ) : undefined
          }
        >
          <div className="form-grid">
            <Field label="Warn of shortages starting within (weeks)" htmlFor="th-lead" error={err || undefined}>
              <input id="th-lead" type="number" className="input" disabled={!canEdit} value={t.shortageLeadWeeks} onChange={(e) => setT({ ...t, shortageLeadWeeks: Number(e.target.value) })} />
            </Field>
            <Field label="Warn of renewals within (days)" htmlFor="th-ren">
              <input id="th-ren" type="number" className="input" disabled={!canEdit} value={t.renewalWindowDays} onChange={(e) => setT({ ...t, renewalWindowDays: Number(e.target.value) })} />
            </Field>
            <Field label="Denials in 4 weeks that raise an alert" htmlFor="th-den">
              <input id="th-den" type="number" className="input" disabled={!canEdit} value={t.denialLimit} onChange={(e) => setT({ ...t, denialLimit: Number(e.target.value) })} />
            </Field>
          </div>
        </Panel>

        <Panel title="Planning assumptions" sub="Fixed in this prototype · shown wherever they are used">
          <table className="statement">
            <tbody>
              <tr>
                <td>Working hours per seat-week (utilisation)</td>
                <td className="num">50 h</td>
              </tr>
              <tr>
                <td>High-demand case</td>
                <td className="num">P50 + 1.28σ (P90)</td>
              </tr>
              <tr>
                <td>Temporary access premium</td>
                <td className="num">{TEMP_PREMIUM}× annual rate</td>
              </tr>
              <tr>
                <td>Idle time-out recovers</td>
                <td className="num">{Math.round(IDLE_RECOVERY_SHARE * 100)}% of idle check-out</td>
              </tr>
              <tr>
                <td>Named seat counted unused after</td>
                <td className="num">90 days</td>
              </tr>
              <tr>
                <td>Cost of blocked time ({fin.version})</td>
                <td className="num">
                  ₹{num(fin.loadedHourlyCost)}/h × {fin.productivityLoss}
                </td>
              </tr>
              <tr>
                <td>Approval limits</td>
                <td className="num">
                  {inrShort(state.limits.tier1)} / {inrShort(state.limits.tier2)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 8 }}>
            Finance inputs are versioned in <Link to="/review">Review & Savings</Link>
            {perms.areas.includes('registry') ? (
              <>
                ; approval limits in <Link to="/registry?tab=limits">Licence & Project → Limits</Link>
              </>
            ) : null}
            . Limits last changed by {state.limits.updatedBy}, {fmtDate(state.limits.updatedAt.slice(0, 10))}.
          </p>
        </Panel>

        <Panel title="Data sources and integrations" sub="What is real in this prototype and what is simulated">
          {INTEGRATIONS.map((i) => (
            <div key={i.name} className="integration-row">
              <div>
                <b style={{ fontWeight: 600 }}>{i.name}</b>
                <div className="muted">Production: {i.prod}</div>
                <div>Here: {i.here}</div>
              </div>
              <span className={`chip ${i.status === 'none' ? 'neutral dashed' : i.status === 'mock' ? 'warn' : 'info'}`}>{i.status === 'mock' ? 'Simulated' : i.status === 'sample' ? 'Sample data' : 'Not connected'}</span>
            </div>
          ))}
        </Panel>

        <Panel title="Demo data" sub="Everything you change is stored in this browser only">
          <Callout>
            Requests, approvals, scenarios, imports and review evidence you add are saved in this browser’s local storage under the demo key. Resetting restores the original sample data for every role.
          </Callout>
          <dl className="dl" style={{ marginTop: 10 }}>
            <dt>Audit entries</dt>
            <dd className="mono">{state.audit.length}</dd>
            <dt>Saved scenarios</dt>
            <dd className="mono">{state.scenarios.length}</dd>
            <dt>Imported rows</dt>
            <dd className="mono">{state.importedRows}</dd>
          </dl>
          <button className="btn danger" style={{ marginTop: 12 }} onClick={() => setConfirm(true)}>
            <RotateCcw /> Reset to sample data
          </button>
        </Panel>
      </div>
      {confirm && (
        <Dialog
          title="Reset all demo changes?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  actions.reset();
                  setT({ ...DEFAULT_THRESHOLDS });
                  setConfirm(false);
                }}
              >
                Reset
              </button>
            </>
          }
        >
          <p className="small">This clears every request, approval, scenario, import and invoice entered in this browser. It cannot be undone.</p>
        </Dialog>
      )}
    </>
  );
}
