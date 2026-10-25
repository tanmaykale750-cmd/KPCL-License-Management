import { CircleCheck, Download, FileSpreadsheet, Upload, Wand2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  FIELDS,
  ISSUE_LABEL,
  SAMPLE_IMPORT,
  autoMap,
  fingerprint,
  qualityScore,
  rowsFromTable,
  validateRows,
  type FieldKey,
  type ImportRow,
  type IssueKind,
} from '../../calc/importValidation';
import { DataTable } from '../../components/ui/DataTable';
import { Callout, Panel } from '../../components/ui/basics';
import { StatusChip } from '../../components/ui/StatusChip';
import { DEMO_TODAY, fmtDateTime } from '../../lib/dates';
import { parseCSV } from '../../lib/csv';
import { num, pct } from '../../lib/format';
import { useApp } from '../../state/store';

interface Loaded {
  fileName: string;
  headers: string[];
  table: string[][];
  mapping: Partial<Record<FieldKey, number>>;
  fp: string;
}

const FIELD_LABEL: Record<FieldKey, string> = { username: 'Username', feature: 'Feature code', machine: 'Machine', checkout: 'Check-out', checkin: 'Check-in', timezone: 'Time zone' };

export function ImportTab() {
  const { ds, state, perms, actions, toast } = useApp();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [service, setService] = useState<string[]>([]);
  const [featureMap, setFeatureMap] = useState<Record<string, string>>({});
  const [onlyIssues, setOnlyIssues] = useState(true);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const ctx = { users: ds.users, licences: ds.licences, today: DEMO_TODAY, maxSessionHours: 24, serverZone: 'Asia/Kolkata (IST)', extraUsernames: service, extraFeatures: featureMap };
  const validated = useMemo(() => validateRows(rows, ctx), [rows, service, featureMap, ds]); // eslint-disable-line react-hooks/exhaustive-deps
  const score = qualityScore(validated);
  const counts = useMemo(() => {
    const c: Partial<Record<IssueKind, number>> = {};
    validated.forEach((r) => new Set(r.issues.map((i) => i.kind)).forEach((k) => (c[k] = (c[k] ?? 0) + 1)));
    return c;
  }, [validated]);
  const duplicateFile = loaded && state.imports.some((b) => b.fingerprint === loaded.fp);

  const load = (fileName: string, table: string[][], fp: string) => {
    if (table.length < 2) {
      setError('The file has no data rows.');
      return;
    }
    const headers = table[0].map((h) => String(h));
    const mapping = autoMap(headers);
    const missing = (['username', 'feature', 'checkout'] as FieldKey[]).filter((f) => mapping[f] === undefined);
    setError(missing.length ? `Could not find columns for: ${missing.join(', ')}. Rename the headers or map them below.` : '');
    setLoaded({ fileName, headers, table, mapping, fp });
    setRows(rowsFromTable(table, mapping));
    setService([]);
    setFeatureMap({});
  };

  const onFile = async (f: File) => {
    setError('');
    try {
      if (/\.xlsx$/i.test(f.name)) {
        const { default: readXlsxFile } = await import('read-excel-file');
        const data = await readXlsxFile(f);
        const table = data.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 19) : c === null ? '' : String(c))));
        load(f.name, table, fingerprint(JSON.stringify(table)));
      } else if (/\.(csv|txt)$/i.test(f.name)) {
        const text = await f.text();
        load(f.name, parseCSV(text), fingerprint(text));
      } else setError('Upload a .csv or .xlsx file.');
    } catch (e) {
      setError(`Could not read the file: ${(e as Error).message}`);
    }
  };

  const remap = (field: FieldKey, idx: number | undefined) => {
    if (!loaded) return;
    const mapping = { ...loaded.mapping, [field]: idx };
    setLoaded({ ...loaded, mapping });
    setRows(rowsFromTable(loaded.table, mapping));
  };

  const edit = (line: number, field: FieldKey, value: string) => setRows((rs) => rs.map((r) => (r.line === line ? { ...r, values: { ...r.values, [field]: value }, corrected: r.corrected + 1 } : r)));
  const exclude = (line: number) => setRows((rs) => rs.map((r) => (r.line === line ? { ...r, excluded: 'Excluded by the administrator during review (logged with the batch)' } : r)));
  const applySuggestions = () => {
    let n = 0;
    const next = rows.map((r) => {
        const v = validated.find((x) => x.line === r.line);
        if (!v) return r;
        let values = { ...r.values };
        let changed = 0;
        for (const i of v.issues) {
          if (!i.suggestion) continue;
          if (i.kind === 'unknown-user') values = { ...values, username: i.suggestion };
          if (i.kind === 'missing-timezone') values = { ...values, timezone: 'IST' };
          if (i.kind === 'ambiguous-date') values = { ...values, checkout: `${i.suggestion.replace(' ', 'T')}:00` };
          changed++;
        }
        n += changed;
        return changed ? { ...r, values, corrected: r.corrected + changed } : r;
    });
    setRows(next);
    toast(`${n} suggested fixes applied. Review the remaining rows.`, 'info');
  };

  const commit = () => {
    if (!loaded) return;
    const ok = validated.filter((r) => !r.excluded && r.issues.length === 0).length;
    const excluded = validated.filter((r) => r.excluded).length;
    const held = validated.filter((r) => !r.excluded && r.issues.length > 0).length;
    if (held > 0) {
      toast(`${held} rows still have problems. Fix or exclude them first — rows are never dropped silently.`, 'warn');
      return;
    }
    actions.commitImport({ fileName: loaded.fileName, rowsTotal: validated.length, rowsCommitted: ok, rowsExcluded: excluded, qualityScore: score, corrections: rows.reduce((s, r) => s + r.corrected, 0), fingerprint: loaded.fp });
    setLoaded(null);
    setRows([]);
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_IMPORT], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'licence-log-sample-with-errors.csv';
    a.click();
  };

  if (!perms.importData)
    return (
      <Panel title="Imports">
        <Callout>Only licence administrators import and correct usage data. You can see the import history below.</Callout>
        <ImportHistory />
      </Panel>
    );

  const visible = onlyIssues ? validated.filter((r) => r.issues.length || r.excluded) : validated;

  return (
    <div className="stack-lg">
      <Panel
        title="Import usage logs or Excel files"
        sub="Every import is checked before it reaches analysis. Problem rows are held for correction, never silently dropped."
        actions={
          <>
            <button className="btn" onClick={downloadSample}>
              <Download /> Sample file
            </button>
            <button className="btn" onClick={() => load('licence-log-sample-with-errors.csv', parseCSV(SAMPLE_IMPORT), fingerprint(SAMPLE_IMPORT))}>
              <FileSpreadsheet /> Load sample
            </button>
            <button className="btn primary" onClick={() => fileRef.current?.click()}>
              <Upload /> Upload .csv / .xlsx
            </button>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.txt" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </>
        }
      >
        {!loaded && (
          <Callout>
            Expected columns: username, feature, machine, checkout, checkin, timezone (headers are matched automatically). Committed rows go into this prototype’s store only — nothing is written to a licence server or ERP.
          </Callout>
        )}
        {error && (
          <div style={{ marginTop: 8 }}>
            <Callout tone="warn">{error}</Callout>
          </div>
        )}
        {loaded && (
          <>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <div className="kv-strip">
                <span>
                  File <b className="mono">{loaded.fileName}</b>
                </span>
                <span>
                  Rows <b>{num(validated.length)}</b>
                </span>
                <span>
                  Data-quality score <b>{pct(score)}</b>
                </span>
                <span>
                  Fingerprint <b className="mono">{loaded.fp}</b>
                </span>
              </div>
              {duplicateFile && <StatusChip status="rejected">This file was already imported</StatusChip>}
            </div>
            <div className="table-wrap" style={{ marginBottom: 12 }}>
              <table className="table table-compact">
                <thead>
                  <tr>
                    {FIELDS.map((f) => (
                      <th key={f}>{FIELD_LABEL[f]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {FIELDS.map((f) => (
                      <td key={f}>
                        <select className="select" style={{ height: 26, width: '100%' }} aria-label={`Column for ${FIELD_LABEL[f]}`} value={loaded.mapping[f] ?? ''} onChange={(e) => remap(f, e.target.value === '' ? undefined : Number(e.target.value))}>
                          <option value="">— not mapped —</option>
                          {loaded.headers.map((h, i) => (
                            <option key={i} value={i}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="grid-3-even" style={{ gridTemplateColumns: 'repeat(7, minmax(0,1fr))', gap: 8 }}>
              {(Object.keys(ISSUE_LABEL) as IssueKind[]).map((k) => (
                <div key={k} className="panel" style={{ padding: '8px 10px', borderColor: counts[k] ? 'var(--warn)' : 'var(--border)' }}>
                  <div className="small muted">{ISSUE_LABEL[k]}</div>
                  <div className="num" style={{ fontSize: 18, fontWeight: 600, color: counts[k] ? 'var(--warn)' : 'var(--text)' }}>
                    {counts[k] ?? 0}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Panel>

      {loaded && (
        <Panel
          flush
          title="Review and correct"
          sub="Edit cells in place, apply suggested fixes, mark service accounts, map unknown features, or exclude a row with a logged reason"
          actions={
            <>
              <label className="checkbox small">
                <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Only rows with problems
              </label>
              <button className="btn" onClick={applySuggestions}>
                <Wand2 /> Apply suggested fixes
              </button>
              <button className="btn primary" onClick={commit} disabled={!!duplicateFile}>
                <CircleCheck /> Commit validated rows
              </button>
            </>
          }
        >
          <DataTable
            rows={visible}
            rowKey={(r) => String(r.line)}
            rowClass={(r) => (r.excluded ? '' : r.issues.length ? 'flag-warn' : '')}
            empty={<div className="empty">All rows pass every check.</div>}
            columns={[
              { key: 'l', header: 'Line', render: (r) => <span className="mono">{r.line}</span> },
              ...(['username', 'feature', 'machine', 'checkout', 'checkin', 'timezone'] as FieldKey[]).map((f) => ({
                key: f,
                header: FIELD_LABEL[f],
                render: (r: ImportRow) => (
                  <input
                    className="input mono"
                    aria-label={`${FIELD_LABEL[f]} line ${r.line}`}
                    style={{ height: 26, width: f === 'checkout' || f === 'checkin' ? 178 : f === 'timezone' ? 60 : 118, fontSize: 11.5, borderColor: r.issues.some((i) => i.field === f) ? 'var(--warn)' : undefined }}
                    value={r.values[f]}
                    disabled={!!r.excluded}
                    onChange={(e) => edit(r.line, f, e.target.value)}
                  />
                ),
              })),
              {
                key: 'iss',
                header: 'Problems and fixes',
                render: (r: ImportRow) =>
                  r.excluded ? (
                    <span className="small muted">{r.excluded}</span>
                  ) : r.issues.length === 0 ? (
                    <StatusChip status="healthy">Valid</StatusChip>
                  ) : (
                    <div className="stack" style={{ gap: 4, minWidth: 250 }}>
                      {r.issues.map((i, k) => (
                        <div key={k} className="small">
                          <span className="text-warn" style={{ fontWeight: 600 }}>
                            {ISSUE_LABEL[i.kind]}:
                          </span>{' '}
                          {i.message}
                          {i.suggestionLabel && (
                            <button
                              className="link-btn"
                              style={{ marginLeft: 6 }}
                              onClick={() => {
                                if (i.kind === 'unknown-user') edit(r.line, 'username', i.suggestion!);
                                if (i.kind === 'missing-timezone') edit(r.line, 'timezone', 'IST');
                                if (i.kind === 'ambiguous-date') edit(r.line, 'checkout', `${i.suggestion!.replace(' ', 'T')}:00`);
                              }}
                            >
                              {i.suggestionLabel}
                            </button>
                          )}
                          {i.kind === 'unknown-user' && !i.suggestion && (
                            <button className="link-btn" style={{ marginLeft: 6 }} onClick={() => setService((s) => [...s, r.values.username])}>
                              Mark as shared or service account
                            </button>
                          )}
                          {i.kind === 'unknown-feature' && (
                            <select className="select" style={{ height: 24, marginLeft: 6, fontSize: 11.5 }} aria-label="Map feature to product" value="" onChange={(e) => e.target.value && setFeatureMap((m) => ({ ...m, [r.values.feature.toLowerCase()]: e.target.value }))}>
                              <option value="">Map to product…</option>
                              {ds.licences.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.product}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      ))}
                      <button className="link-btn small" style={{ color: 'var(--crit)' }} onClick={() => exclude(r.line)}>
                        Exclude row
                      </button>
                    </div>
                  ),
              },
            ]}
          />
        </Panel>
      )}
      <Panel title="Import history" flush>
        <ImportHistory />
      </Panel>
    </div>
  );
}

function ImportHistory() {
  const { state } = useApp();
  return (
    <DataTable
      rows={state.imports}
      rowKey={(b) => b.id}
      empty={<div className="empty">No imports yet in this demo. Committed batches appear here with their quality score.</div>}
      columns={[
        { key: 'id', header: 'Batch', render: (b) => <span className="mono">{b.id}</span> },
        { key: 'f', header: 'File', render: (b) => b.fileName },
        { key: 'at', header: 'Imported', render: (b) => <span className="mono small">{fmtDateTime(b.importedAt)}</span> },
        { key: 'by', header: 'By', render: (b) => b.importedBy },
        { key: 'r', header: 'Rows committed', num: true, render: (b) => `${b.rowsCommitted} of ${b.rowsTotal}` },
        { key: 'x', header: 'Excluded', num: true, render: (b) => b.rowsExcluded },
        { key: 'c', header: 'Corrections', num: true, render: (b) => b.corrections },
        { key: 'q', header: 'Quality on arrival', num: true, render: (b) => pct(b.qualityScore) },
        { key: 'fp', header: 'Fingerprint', render: (b) => <span className="mono small">{b.fingerprint}</span> },
      ]}
    />
  );
}
