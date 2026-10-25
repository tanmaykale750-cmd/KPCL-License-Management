import type { Dataset } from '../../data/dataset';
import { parseCSV } from '../../lib/csv';
import { autoMap, qualityScore, rowsFromTable, SAMPLE_IMPORT, validateRows } from '../importValidation';

export { autoMap };

export function parseCSVRows() {
  const table = parseCSV(SAMPLE_IMPORT);
  return { table, mapping: autoMap(table[0]) };
}

export function qualityScoreFor(table: string[][], mapping: ReturnType<typeof autoMap>, ds: Dataset) {
  const rows = validateRows(rowsFromTable(table, mapping), { users: ds.users, licences: ds.licences, today: '2026-10-25', maxSessionHours: 24, serverZone: 'Asia/Kolkata' });
  return { issues: rows.reduce((a, r) => a + r.issues.length, 0), quality: qualityScore(rows) };
}
