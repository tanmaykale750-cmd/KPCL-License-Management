/**
 * Static sample catalogue. All names, figures, contracts and invoices are synthetic.
 * Nothing here is KPCL company data.
 */
import type { Department, Licence, Project, Vendor } from '../domain/types';

export const DEPARTMENTS: Department[] = [
  { id: 'design', name: 'Design', fullName: 'Mechanical Design', costCentre: 'CC-4101', headUserId: 'u-meera', annualBudget: 1_65_00_000, headcount: 34, headcountNextYear: 36 },
  { id: 'engg', name: 'Engineering', fullName: 'Product Engineering', costCentre: 'CC-4102', headUserId: 'u-sanjay', annualBudget: 95_00_000, headcount: 30, headcountNextYear: 31 },
  { id: 'sim', name: 'Simulation', fullName: 'Simulation & Analysis', costCentre: 'CC-4105', headUserId: 'u-harish', annualBudget: 1_35_00_000, headcount: 17, headcountNextYear: 18 },
  { id: 'rnd', name: 'R&D', fullName: 'Research & Development', costCentre: 'CC-4108', headUserId: 'u-anjali', annualBudget: 70_00_000, headcount: 16, headcountNextYear: 17 },
  { id: 'mfg', name: 'Manufacturing', fullName: 'Manufacturing Engineering', costCentre: 'CC-5201', headUserId: 'u-vikram', annualBudget: 42_00_000, headcount: 26, headcountNextYear: 26 },
  { id: 'it', name: 'IT', fullName: 'IT & PLM Support', costCentre: 'CC-6001', headUserId: 'u-neha', annualBudget: 12_00_000, headcount: 12, headcountNextYear: 12 },
];

export const VENDORS: Vendor[] = [
  { id: 'v-ansys', name: 'Ansys (Synopsys)', accountManager: 'Channel partner — West India', paymentTerms: 'Annual lease, 45 days' },
  { id: 'v-autodesk', name: 'Autodesk', accountManager: 'Authorised reseller — Pune', paymentTerms: 'Annual subscription, 30 days' },
  { id: 'v-dassault', name: 'Dassault Systèmes (SolidWorks)', accountManager: 'VAR — Pune', paymentTerms: 'Annual term licence, 30 days' },
  { id: 'v-altair', name: 'Altair (Siemens)', accountManager: 'Direct — India', paymentTerms: 'Annual units, 45 days' },
  { id: 'v-cadence', name: 'Cadence', accountManager: 'Distributor — Bengaluru', paymentTerms: 'Annual term, 60 days' },
];

const hadapsar = 'lic-hdp-01.kpcl.local';
const nashik = 'lic-nsk-02.kpcl.local';

export const LICENCES: Licence[] = [
  {
    id: 'ANS-MECH', product: 'ANSYS Mechanical Enterprise', feature: 'mech_ent (solver + pre/post)', family: 'ANSYS',
    vendorId: 'v-ansys', type: 'floating', seats: 10, unitLabel: 'seats', costPerSeat: 11_00_000, ownerDeptId: 'sim',
    allocations: { sim: 7, rnd: 2, engg: 1 }, contractRef: 'CTR-ANS-2024-017', poRef: 'PO-4500018342',
    startDate: '2024-04-01', renewalDate: '2027-03-31', noticeDays: 60, contractMinSeats: 6, server: hadapsar,
    status: 'active', rehostableWith: ['ANS-MECH-NSK'], forecastable: true,
  },
  {
    id: 'ANS-MECH-NSK', product: 'ANSYS Mechanical Enterprise', feature: 'mech_ent — Nashik pool', family: 'ANSYS',
    vendorId: 'v-ansys', type: 'floating', seats: 3, unitLabel: 'seats', costPerSeat: 11_00_000, ownerDeptId: 'engg',
    allocations: { engg: 2, mfg: 1 }, contractRef: 'CTR-ANS-2024-017', poRef: 'PO-4500018342',
    startDate: '2024-04-01', renewalDate: '2027-03-31', noticeDays: 60, contractMinSeats: 0, server: nashik,
    status: 'active', rehostableWith: ['ANS-MECH'], forecastable: true,
  },
  {
    id: 'ANS-HPC', product: 'ANSYS HPC Pack', feature: 'anshpc_pack (add-on)', family: 'ANSYS',
    vendorId: 'v-ansys', type: 'floating', seats: 4, unitLabel: 'packs', costPerSeat: 3_40_000, ownerDeptId: 'sim',
    allocations: { sim: 4 }, contractRef: 'CTR-ANS-2024-017', poRef: 'PO-4500018342',
    startDate: '2024-04-01', renewalDate: '2027-03-31', noticeDays: 60, contractMinSeats: 0, server: hadapsar,
    status: 'active', baseLicenceId: 'ANS-MECH', forecastable: true,
  },
  {
    id: 'ANS-CFD', product: 'ANSYS Fluent', feature: 'cfd_base', family: 'ANSYS',
    vendorId: 'v-ansys', type: 'floating', seats: 4, unitLabel: 'seats', costPerSeat: 9_00_000, ownerDeptId: 'sim',
    allocations: { sim: 3, rnd: 1 }, contractRef: 'CTR-ANS-2024-017', poRef: 'PO-4500018342',
    startDate: '2024-04-01', renewalDate: '2027-03-31', noticeDays: 60, contractMinSeats: 2, server: hadapsar,
    status: 'active', forecastable: true,
  },
  {
    id: 'INV-PRO', product: 'Autodesk Inventor Professional', feature: 'Named-user subscription', family: 'Autodesk',
    vendorId: 'v-autodesk', type: 'named', seats: 52, unitLabel: 'seats', costPerSeat: 2_40_000, ownerDeptId: 'design',
    allocations: { design: 24, engg: 14, mfg: 9, rnd: 5 }, contractRef: 'CTR-ADSK-2025-006', poRef: 'PO-4500021907',
    startDate: '2025-12-10', renewalDate: '2026-12-09', noticeDays: 30, contractMinSeats: 20, server: 'Autodesk Account (cloud)',
    status: 'renewal-due', forecastable: false,
  },
  {
    id: 'ACAD-MECH', product: 'AutoCAD Mechanical', feature: 'Named-user subscription', family: 'Autodesk',
    vendorId: 'v-autodesk', type: 'named', seats: 30, unitLabel: 'seats', costPerSeat: 95_000, ownerDeptId: 'mfg',
    allocations: { mfg: 12, design: 8, engg: 6, it: 4 }, contractRef: 'CTR-ADSK-2025-006', poRef: 'PO-4500021907',
    startDate: '2026-04-01', renewalDate: '2027-03-31', noticeDays: 30, contractMinSeats: 10, server: 'Autodesk Account (cloud)',
    status: 'active', forecastable: false,
  },
  {
    id: 'ADSK-VAULT', product: 'Autodesk Vault Professional', feature: 'Named-user subscription', family: 'Autodesk',
    vendorId: 'v-autodesk', type: 'named', seats: 12, unitLabel: 'seats', costPerSeat: 85_000, ownerDeptId: 'it',
    allocations: { it: 6, design: 6 }, contractRef: 'CTR-ADSK-2025-006', poRef: 'PO-4500021907',
    startDate: '2025-12-10', renewalDate: '2026-12-09', noticeDays: 30, contractMinSeats: 5, server: 'Autodesk Account (cloud)',
    status: 'renewal-due', forecastable: false,
  },
  {
    id: 'ADSK-FLEX', product: 'Autodesk Flex tokens', feature: 'Prepaid tokens (24-hour use)', family: 'Autodesk',
    vendorId: 'v-autodesk', type: 'token', seats: 2, unitLabel: 'seat-eq.', costPerSeat: 60_000, ownerDeptId: 'design',
    allocations: { design: 1, mfg: 1 }, contractRef: 'CTR-ADSK-2025-006', poRef: 'PO-4500024410',
    startDate: '2026-04-15', renewalDate: '2027-04-14', noticeDays: 0, contractMinSeats: 0, server: 'Autodesk Account (cloud)',
    status: 'active', forecastable: false,
  },
  {
    id: 'SW-PREM', product: 'SolidWorks Premium', feature: 'solidworks_premium', family: 'SolidWorks',
    vendorId: 'v-dassault', type: 'floating', seats: 20, unitLabel: 'seats', costPerSeat: 2_40_000, ownerDeptId: 'design',
    allocations: { design: 10, engg: 6, mfg: 4 }, contractRef: 'CTR-DS-2025-011', poRef: 'PO-4500022560',
    startDate: '2025-07-01', renewalDate: '2027-06-30', noticeDays: 45, contractMinSeats: 10, server: hadapsar,
    status: 'active', forecastable: true,
  },
  {
    id: 'ALT-HW', product: 'Altair HyperWorks units', feature: 'HWU pool (seat-equivalent)', family: 'Altair',
    vendorId: 'v-altair', type: 'token', seats: 6, unitLabel: 'seat-eq.', costPerSeat: 6_50_000, ownerDeptId: 'sim',
    allocations: { sim: 4, rnd: 2 }, contractRef: 'CTR-ALT-2025-003', poRef: 'PO-4500020118',
    startDate: '2025-10-01', renewalDate: '2026-12-31', noticeDays: 45, contractMinSeats: 4, server: hadapsar,
    status: 'renewal-due', forecastable: true,
  },
  {
    id: 'CAD-ALG', product: 'Cadence Allegro PCB Designer', feature: 'allegro_pcb (node-locked)', family: 'Cadence',
    vendorId: 'v-cadence', type: 'node-locked', seats: 8, unitLabel: 'seats', costPerSeat: 4_80_000, ownerDeptId: 'rnd',
    allocations: { rnd: 6, engg: 2 }, contractRef: 'CTR-CDN-2024-009', poRef: 'PO-4500019773',
    startDate: '2025-02-01', renewalDate: '2027-01-31', noticeDays: 60, contractMinSeats: 4, server: 'Node-locked workstations (8)',
    status: 'active', forecastable: true,
  },
];

/**
 * Projects drive the forecast's project layer.
 * Past projects carry actual peaks, which give the calibration ratio (actual ÷ planned).
 */
export const PROJECTS: Project[] = [
  {
    id: 'PRJ-X', code: 'PRJ-2611', name: 'Compressor redesign (Project X)', shortName: 'Project X', deptId: 'design', ownerDeptName: 'Mechanical Design',
    leaderUserId: 'u-amit', priority: 'high', critical: true, status: 'active', dateStatus: 'confirmed', confidence: 1,
    teams: ['Compressor Design', 'Structural CAE', 'Testing'], productFamily: 'Screw compressors',
    phases: [
      { id: 'PRJ-X-1', name: 'Concept', kind: 'concept', start: '2026-09-01', end: '2026-10-30', demand: [{ licenceId: 'INV-PRO', seats: 2 }] },
      { id: 'PRJ-X-2', name: 'Detailed design', kind: 'detailed-design', start: '2026-11-02', end: '2027-01-15', demand: [{ licenceId: 'INV-PRO', seats: 6 }, { licenceId: 'SW-PREM', seats: 2 }] },
      { id: 'PRJ-X-3', name: 'Simulation & validation', kind: 'simulation', start: '2027-01-18', end: '2027-03-26', demand: [{ licenceId: 'ANS-MECH', seats: 4 }, { licenceId: 'ANS-CFD', seats: 1 }, { licenceId: 'ALT-HW', seats: 1 }] },
      { id: 'PRJ-X-4', name: 'Release', kind: 'release', start: '2027-03-29', end: '2027-04-30', demand: [{ licenceId: 'INV-PRO', seats: 2 }] },
    ],
  },
  {
    id: 'PRJ-Y', code: 'PRJ-2614', name: 'Gearbox upgrade (Project Y)', shortName: 'Project Y', deptId: 'engg', ownerDeptName: 'Product Engineering',
    leaderUserId: 'u-kavita', priority: 'medium', critical: false, status: 'planned', dateStatus: 'confirmed', confidence: 0.85,
    teams: ['Gearbox & Transmission', 'Structural CAE'], productFamily: 'Transmissions',
    phases: [
      { id: 'PRJ-Y-1', name: 'Detailed design', kind: 'detailed-design', start: '2026-11-16', end: '2027-01-08', demand: [{ licenceId: 'INV-PRO', seats: 3 }, { licenceId: 'SW-PREM', seats: 2 }] },
      { id: 'PRJ-Y-2', name: 'Validation', kind: 'validation', start: '2027-01-25', end: '2027-03-12', demand: [{ licenceId: 'ANS-MECH', seats: 2 }, { licenceId: 'ALT-HW', seats: 1 }] },
      { id: 'PRJ-Y-3', name: 'Release', kind: 'release', start: '2027-03-15', end: '2027-04-09', demand: [{ licenceId: 'INV-PRO', seats: 1 }] },
    ],
  },
  {
    id: 'PRJ-CFD', code: 'PRJ-2618', name: 'Screw compressor CFD optimisation', shortName: 'CFD optimisation', deptId: 'sim', ownerDeptName: 'Simulation & Analysis',
    leaderUserId: 'u-sneha', priority: 'medium', critical: false, status: 'planned', dateStatus: 'tentative', confidence: 0.6,
    teams: ['CFD & Thermal'], productFamily: 'Screw compressors',
    phases: [
      { id: 'PRJ-CFD-1', name: 'Simulation', kind: 'simulation', start: '2027-03-01', end: '2027-05-28', demand: [{ licenceId: 'ANS-CFD', seats: 2 }, { licenceId: 'ANS-HPC', seats: 2 }] },
    ],
  },
  {
    id: 'PRJ-CTRL', code: 'PRJ-2620', name: 'Refrigeration skid controller board', shortName: 'Controller board', deptId: 'rnd', ownerDeptName: 'Research & Development',
    leaderUserId: 'u-arjun', priority: 'medium', critical: false, status: 'planned', dateStatus: 'confirmed', confidence: 0.9,
    teams: ['Controls & Electronics'], productFamily: 'Refrigeration',
    phases: [
      { id: 'PRJ-CTRL-1', name: 'Detailed design', kind: 'detailed-design', start: '2027-01-04', end: '2027-03-19', demand: [{ licenceId: 'CAD-ALG', seats: 3 }] },
      { id: 'PRJ-CTRL-2', name: 'Validation', kind: 'validation', start: '2027-03-22', end: '2027-04-30', demand: [{ licenceId: 'ANS-MECH', seats: 1 }] },
    ],
  },
  {
    id: 'PRJ-FIX', code: 'PRJ-2609', name: 'Plant 3 fixture library', shortName: 'Fixture library', deptId: 'mfg', ownerDeptName: 'Manufacturing Engineering',
    leaderUserId: 'u-ganesh', priority: 'low', critical: false, status: 'active', dateStatus: 'confirmed', confidence: 1,
    teams: ['Tooling & Fixtures'], productFamily: 'Manufacturing',
    phases: [
      { id: 'PRJ-FIX-1', name: 'Detailed design', kind: 'detailed-design', start: '2026-10-05', end: '2026-12-18', demand: [{ licenceId: 'SW-PREM', seats: 3 }, { licenceId: 'ACAD-MECH', seats: 2 }] },
    ],
  },
  // Completed projects — the source of calibration ratios
  {
    id: 'PRJ-P1', code: 'PRJ-2412', name: 'Screw compressor platform', shortName: 'Screw platform (2025)', deptId: 'design', ownerDeptName: 'Mechanical Design',
    leaderUserId: 'u-amit', priority: 'high', critical: true, status: 'completed', dateStatus: 'confirmed', confidence: 1,
    teams: ['Compressor Design', 'Structural CAE'], productFamily: 'Screw compressors',
    phases: [
      { id: 'PRJ-P1-1', name: 'Simulation & validation', kind: 'simulation', start: '2025-02-03', end: '2025-04-25',
        demand: [{ licenceId: 'ANS-MECH', seats: 5 }, { licenceId: 'ALT-HW', seats: 1 }], actualPeak: { 'ANS-MECH': 4, 'ALT-HW': 1 } },
    ],
  },
  {
    id: 'PRJ-P2', code: 'PRJ-2503', name: 'Reciprocating compressor upgrade', shortName: 'Recip upgrade (2025)', deptId: 'engg', ownerDeptName: 'Product Engineering',
    leaderUserId: 'u-kavita', priority: 'medium', critical: false, status: 'completed', dateStatus: 'confirmed', confidence: 1,
    teams: ['Product Engineering', 'Structural CAE'], productFamily: 'Reciprocating compressors',
    phases: [
      { id: 'PRJ-P2-1', name: 'Simulation', kind: 'simulation', start: '2025-08-04', end: '2025-09-26',
        demand: [{ licenceId: 'ANS-MECH', seats: 3 }, { licenceId: 'SW-PREM', seats: 3 }], actualPeak: { 'ANS-MECH': 3, 'SW-PREM': 2 } },
    ],
  },
  {
    id: 'PRJ-P3', code: 'PRJ-2601', name: 'Refrigeration package', shortName: 'Refrigeration pkg (2026)', deptId: 'sim', ownerDeptName: 'Simulation & Analysis',
    leaderUserId: 'u-sneha', priority: 'high', critical: false, status: 'completed', dateStatus: 'confirmed', confidence: 1,
    teams: ['Structural CAE', 'CFD & Thermal'], productFamily: 'Refrigeration',
    phases: [
      { id: 'PRJ-P3-1', name: 'Simulation', kind: 'simulation', start: '2026-02-02', end: '2026-04-10',
        demand: [{ licenceId: 'ANS-MECH', seats: 6 }, { licenceId: 'ANS-CFD', seats: 2 }, { licenceId: 'ALT-HW', seats: 2 }],
        actualPeak: { 'ANS-MECH': 4, 'ANS-CFD': 2, 'ALT-HW': 2 } },
    ],
  },
];

/** Routine (non-project) weekly peak demand parameters for forecastable pools. */
export const ROUTINE: Record<string, { base: number; sd: number; activeShare: number; idleRatio: number; trend: number }> = {
  'ANS-MECH': { base: 6.7, sd: 0.55, activeShare: 0.74, idleRatio: 0.1, trend: 0.05 },
  'ANS-MECH-NSK': { base: 0.8, sd: 0.35, activeShare: 0.6, idleRatio: 0.12, trend: 0 },
  'ANS-HPC': { base: 0.45, sd: 0.25, activeShare: 0.5, idleRatio: 0.05, trend: 0 },
  'ANS-CFD': { base: 2.4, sd: 0.4, activeShare: 0.76, idleRatio: 0.08, trend: 0.04 },
  'SW-PREM': { base: 14.2, sd: 1.0, activeShare: 0.72, idleRatio: 0.16, trend: 0.03 },
  'ALT-HW': { base: 4.2, sd: 0.6, activeShare: 0.7, idleRatio: 0.09, trend: 0.11 },
  'CAD-ALG': { base: 5.3, sd: 0.45, activeShare: 0.74, idleRatio: 0.14, trend: 0.02 },
};

/** Month-of-year seasonality (financial year-end push in Feb–Mar, holiday dip in Dec and May). */
export const SEASON = [0.05, 0.12, 0.15, 0.0, -0.08, -0.02, 0.03, 0.06, 0.08, 0.02, 0.0, -0.12];

export const WORK_HOURS_PER_WEEK = 50; // 5 days x 10 hours (working-hours basis)
