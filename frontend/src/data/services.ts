/**
 * Module 5 sample data: API keys and third-party APIs, AI token usage, and cloud computing.
 * Synthetic and deterministic (seeded). Billing and usage are simulated history — there are no live
 * connections to any provider, and no API secret exists anywhere in this demo: keys carry only a masked
 * identifier and their last four characters.
 */
import type { IdleBasis, MonthKey, ServiceBilling, ServiceCategory, ServiceKey, ServiceMonth, ServiceRecord, ServiceSubType } from '../domain/types';
import { addMonths, monthKey, monthsBack, DEMO_TODAY } from '../lib/dates';
import { gauss, hashString, mulberry32 } from '../lib/rng';

export const SERVICE_MONTHS = 24;
export const SERVICES_CURRENT_MONTH: MonthKey = monthKey(DEMO_TODAY);

interface Seed {
  id: string;
  name: string;
  provider: string;
  category: ServiceCategory;
  subType: ServiceSubType;
  deptId: string | null;
  owner: string;
  billing: ServiceBilling;
  unit: string;
  capacity?: number; // commitment / provisioned capacity per month
  quota?: number; // pay-as-you-go monthly limit
  unitPrice?: number;
  fixedMonthly?: number;
  base: number; // share of capacity used (commitment / provisioned) or units per month (consumption)
  trend?: number; // growth per month
  limitAtCapacity?: number; // usage share above which requests are refused (rate / instance limits)
  blockedPerHit?: number;
  spikes?: Record<MonthKey, number>;
  stoppedFrom?: MonthKey; // provisioned resource stopped from this month; only disks/storage still billed
  stoppedSpend?: number;
  environment?: ServiceRecord['environment'];
  startDate?: string;
  renewalDate?: string;
  renewalKind?: ServiceRecord['renewalKind'];
  note?: string;
  keyPrefix?: string;
}

type KeySeed = { label: string; ownerUserId: string; environment: ServiceKey['environment']; created: string; lastUsed: string; expires: string | null; calls30d: number };

const BASIS: Record<ServiceBilling, IdleBasis> = {
  subscription: 'commitment',
  prepaid: 'commitment',
  reserved: 'commitment',
  'on-demand': 'provisioned',
  payg: 'consumption',
};

const SEEDS: (Seed & { keySeeds?: KeySeed[] })[] = [
  // ---------- API keys and third-party API services ----------
  {
    id: 'SV-API-01', name: 'Google Maps Platform — Routes & Geocoding', provider: 'Google Cloud', category: 'api', subType: 'api', deptId: 'engg', owner: 'u-kavita',
    billing: 'payg', unit: 'k requests', unitPrice: 420, base: 95, trend: 0.01, quota: 150, blockedPerHit: 0.5, environment: 'prod', startDate: '2024-06-01',
    note: 'Service-engineer dispatch and site geocoding.', keyPrefix: 'AIza',
    keySeeds: [
      { label: 'Dispatch app — production', ownerUserId: 'u-kavita', environment: 'prod', created: '2025-02-11', lastUsed: '2026-10-24', expires: null, calls30d: 96_400 },
      { label: 'Route planner — old test key', ownerUserId: 'u-kavita', environment: 'test', created: '2024-06-03', lastUsed: '2026-05-29', expires: null, calls30d: 0 },
    ],
  },
  {
    id: 'SV-API-02', name: 'SendGrid Email API — Pro 100k', provider: 'Twilio SendGrid', category: 'api', subType: 'api', deptId: 'it', owner: 'u-priya',
    billing: 'subscription', unit: 'k emails', capacity: 100, fixedMonthly: 7_500, unitPrice: 85, base: 0.38, environment: 'prod', startDate: '2024-01-15',
    renewalDate: '2027-01-14', renewalKind: 'renewal', note: 'Workflow and approval e-mails from PLM.', keyPrefix: 'SG.',
    keySeeds: [{ label: 'PLM notifications', ownerUserId: 'u-priya', environment: 'prod', created: '2025-01-15', lastUsed: '2026-10-25', expires: '2027-01-14', calls30d: 38_100 }],
  },
  {
    id: 'SV-API-03', name: 'Twilio Programmable SMS — alerts & OTP', provider: 'Twilio', category: 'api', subType: 'api', deptId: null, owner: 'u-neha',
    billing: 'payg', unit: 'k SMS', unitPrice: 2_100, base: 6, trend: 0.004, environment: 'shared', startDate: '2023-11-01',
    note: 'Shared by several systems; not yet charged back to a department.', keyPrefix: 'AC',
    keySeeds: [{ label: 'Shared alerting gateway', ownerUserId: 'u-neha', environment: 'prod', created: '2025-07-01', lastUsed: '2026-10-25', expires: null, calls30d: 6_210 }],
  },
  {
    id: 'SV-API-04', name: 'OpenWeather One Call — Developer', provider: 'OpenWeather', category: 'api', subType: 'api', deptId: 'rnd', owner: 'u-arjun',
    billing: 'subscription', unit: 'k calls', capacity: 1_000, fixedMonthly: 15_000, unitPrice: 15, base: 0.12, environment: 'test', startDate: '2025-03-01',
    renewalDate: '2026-12-01', renewalKind: 'renewal', note: 'Ambient conditions for outdoor compressor test rigs.', keyPrefix: 'owm_',
    keySeeds: [
      { label: 'Test-rig logger', ownerUserId: 'u-arjun', environment: 'test', created: '2025-03-02', lastUsed: '2026-10-22', expires: null, calls30d: 118_000 },
      { label: 'Field trial — Chakan', ownerUserId: 'u-arjun', environment: 'test', created: '2025-08-18', lastUsed: '2026-04-11', expires: null, calls30d: 0 },
    ],
  },
  {
    id: 'SV-API-05', name: 'Teamcenter REST gateway — API tier', provider: 'Siemens Digital Industries', category: 'api', subType: 'api', deptId: 'it', owner: 'u-priya',
    billing: 'subscription', unit: 'k calls', capacity: 2_000, fixedMonthly: 60_000, unitPrice: 30, base: 0.71, trend: 0.006, limitAtCapacity: 0.86, blockedPerHit: 1.5, spikes: { '2026-03': 1.4 },
    environment: 'prod', startDate: '2023-04-01', renewalDate: '2027-03-31', renewalKind: 'renewal', note: 'PLM integrations: CAD check-in, BOM sync, licence reports.', keyPrefix: 'tcg-',
    keySeeds: [
      { label: 'BOM sync service', ownerUserId: 'u-priya', environment: 'prod', created: '2025-04-01', lastUsed: '2026-10-25', expires: '2027-03-31', calls30d: 1_210_000 },
      { label: 'CAD check-in bridge', ownerUserId: 'u-neha', environment: 'prod', created: '2025-04-01', lastUsed: '2026-10-25', expires: '2027-03-31', calls30d: 302_000 },
    ],
  },
  {
    id: 'SV-API-06', name: 'Granta MI materials data API', provider: 'Ansys Granta', category: 'api', subType: 'api', deptId: 'design', owner: 'u-meera',
    billing: 'subscription', unit: 'k queries', capacity: 20, fixedMonthly: 45_000, unitPrice: 2_400, base: 0.46, environment: 'prod', startDate: '2024-12-21',
    renewalDate: '2026-12-20', renewalKind: 'renewal', note: 'Material property look-ups from CAD and BOM tools.', keyPrefix: 'gmi_',
    keySeeds: [{ label: 'CAD material picker', ownerUserId: 'u-meera', environment: 'prod', created: '2024-12-21', lastUsed: '2026-10-24', expires: '2026-12-20', calls30d: 9_300 }],
  },
  {
    id: 'SV-API-07', name: 'CAD Exchanger Cloud — conversion credits', provider: 'CAD Exchanger', category: 'api', subType: 'api', deptId: 'design', owner: 'u-amit',
    billing: 'prepaid', unit: 'conversions', capacity: 1_200, fixedMonthly: 38_000, unitPrice: 40, base: 0.84, trend: 0.004, environment: 'prod', startDate: '2025-05-01',
    renewalDate: '2027-04-30', renewalKind: 'commitment ends', note: 'Customer STEP / JT conversions for quotations.', keyPrefix: 'cdx_',
    keySeeds: [{ label: 'Quotation pipeline', ownerUserId: 'u-amit', environment: 'prod', created: '2025-05-01', lastUsed: '2026-10-23', expires: null, calls30d: 1_020 }],
  },
  {
    id: 'SV-API-08', name: 'DeepL API Pro — manual translation', provider: 'DeepL', category: 'api', subType: 'api', deptId: 'engg', owner: 'u-sanjay',
    billing: 'subscription', unit: 'M characters', capacity: 5, fixedMonthly: 22_000, unitPrice: 2_100, base: 0.27, environment: 'prod', startDate: '2025-01-10',
    renewalDate: '2027-01-09', renewalKind: 'renewal', note: 'Operating manuals for export markets.', keyPrefix: 'dpl-',
    keySeeds: [{ label: 'Docs pipeline', ownerUserId: 'u-sanjay', environment: 'prod', created: '2025-01-10', lastUsed: '2026-09-02', expires: null, calls30d: 14 }],
  },
  {
    id: 'SV-API-09', name: 'Azure AI Document Intelligence — inspection OCR', provider: 'Microsoft Azure', category: 'api', subType: 'api', deptId: 'mfg', owner: 'u-ganesh',
    billing: 'payg', unit: 'k pages', unitPrice: 840, base: 30, trend: 0.012, environment: 'prod', startDate: '2025-09-01',
    note: 'Digitises paper inspection reports from the shop floor.', keyPrefix: 'adi-',
    keySeeds: [{ label: 'Inspection scanner', ownerUserId: 'u-ganesh', environment: 'prod', created: '2025-09-01', lastUsed: '2026-10-24', expires: '2026-12-31', calls30d: 31_800 }],
  },

  // ---------- AI token usage and commitments ----------
  {
    id: 'SV-AI-01', name: 'Azure OpenAI GPT-4.1 — provisioned throughput', provider: 'Microsoft Azure', category: 'ai', subType: 'ai', deptId: 'rnd', owner: 'u-anjali',
    billing: 'reserved', unit: 'M tokens', capacity: 900, fixedMonthly: 4_20_000, unitPrice: 0, base: 0.31, trend: 0.006, environment: 'prod', startDate: '2026-04-01',
    renewalDate: '2027-03-31', renewalKind: 'reservation ends', note: 'Monthly throughput reservation; unused throughput is not carried forward.', keyPrefix: 'aoai-',
    keySeeds: [
      { label: 'Engineering knowledge assistant', ownerUserId: 'u-anjali', environment: 'prod', created: '2026-04-01', lastUsed: '2026-10-25', expires: null, calls30d: 41_200 },
      { label: 'Pilot — test-report summariser', ownerUserId: 'u-arjun', environment: 'dev', created: '2026-04-09', lastUsed: '2026-06-30', expires: null, calls30d: 0 },
    ],
  },
  {
    id: 'SV-AI-02', name: 'Anthropic Claude API — prepaid credits', provider: 'Anthropic', category: 'ai', subType: 'ai', deptId: 'engg', owner: 'u-sanjay',
    billing: 'prepaid', unit: 'M tokens', capacity: 260, fixedMonthly: 1_10_000, unitPrice: 520, base: 0.88, trend: 0.008, limitAtCapacity: 0.9, blockedPerHit: 0.75,
    environment: 'prod', startDate: '2025-10-01', renewalDate: '2026-12-31', renewalKind: 'commitment ends', note: 'Code review and specification drafting; usage above credits billed at list price.', keyPrefix: 'sk-ant-',
    keySeeds: [
      { label: 'Spec drafting tool', ownerUserId: 'u-sanjay', environment: 'prod', created: '2025-10-01', lastUsed: '2026-10-25', expires: null, calls30d: 22_800 },
      { label: 'Firmware code review', ownerUserId: 'u-kavita', environment: 'prod', created: '2026-02-14', lastUsed: '2026-10-25', expires: null, calls30d: 11_400 },
    ],
  },
  {
    id: 'SV-AI-03', name: 'OpenAI API — pay-as-you-go', provider: 'OpenAI', category: 'ai', subType: 'ai', deptId: 'design', owner: 'u-amit',
    billing: 'payg', unit: 'M tokens', unitPrice: 460, base: 95, trend: 0.012, quota: 150, blockedPerHit: 0.5, spikes: { '2026-06': 1.8 }, environment: 'prod', startDate: '2025-04-01',
    note: 'Quotation text and drawing-note checks. Organisation usage tier caps monthly tokens.', keyPrefix: 'sk-proj-',
    keySeeds: [
      { label: 'Quotation assistant', ownerUserId: 'u-amit', environment: 'prod', created: '2025-04-01', lastUsed: '2026-10-25', expires: null, calls30d: 18_900 },
      { label: 'Hackathon prototype', ownerUserId: 'u-meera', environment: 'dev', created: '2025-11-20', lastUsed: '2026-01-15', expires: null, calls30d: 0 },
    ],
  },
  {
    id: 'SV-AI-04', name: 'Google Gemini API — pay-as-you-go', provider: 'Google Cloud', category: 'ai', subType: 'ai', deptId: 'sim', owner: 'u-sneha',
    billing: 'payg', unit: 'M tokens', unitPrice: 290, base: 60, trend: 0.01, spikes: { '2026-08': 3.2 }, environment: 'prod', startDate: '2025-07-01',
    note: 'Summaries of simulation run logs. August: one-off batch over the 2024–25 archive.', keyPrefix: 'AIza',
    keySeeds: [{ label: 'Run-log summariser', ownerUserId: 'u-sneha', environment: 'prod', created: '2025-07-01', lastUsed: '2026-10-25', expires: null, calls30d: 7_600 }],
  },
  {
    id: 'SV-AI-05', name: 'Azure OpenAI embeddings — document search', provider: 'Microsoft Azure', category: 'ai', subType: 'ai', deptId: null, owner: 'u-neha',
    billing: 'payg', unit: 'M tokens', unitPrice: 11, base: 1_500, trend: 0.015, environment: 'shared', startDate: '2025-12-01',
    note: 'Company-wide document search index; not yet charged back.', keyPrefix: 'aoai-',
    keySeeds: [{ label: 'Search indexer', ownerUserId: 'u-neha', environment: 'prod', created: '2025-12-01', lastUsed: '2026-10-25', expires: null, calls30d: 52_000 }],
  },

  // ---------- Cloud computing ----------
  {
    id: 'SV-CL-01', name: 'CAE pre/post VM pool — 8 × D16s v5', provider: 'Microsoft Azure', category: 'cloud', subType: 'vm', deptId: 'sim', owner: 'u-harish',
    billing: 'on-demand', unit: 'vCPU-h', capacity: 51_200, fixedMonthly: 2_05_000, base: 0.42, environment: 'prod', startDate: '2025-01-01', note: 'Runs 400 h a month on a schedule; busy share from CPU telemetry.',
  },
  {
    id: 'SV-CL-02', name: 'PLM test servers — 2 × E8s v5 (1-yr reserved)', provider: 'Microsoft Azure', category: 'cloud', subType: 'vm', deptId: 'it', owner: 'u-priya',
    billing: 'reserved', unit: 'vCPU-h', capacity: 11_680, fixedMonthly: 58_000, base: 0.19, environment: 'test', startDate: '2026-01-01', renewalDate: '2026-12-31', renewalKind: 'reservation ends',
  },
  {
    id: 'SV-CL-03', name: 'MES staging VMs — stopped, disks still billed', provider: 'Microsoft Azure', category: 'cloud', subType: 'vm', deptId: 'mfg', owner: 'u-vikram',
    billing: 'on-demand', unit: 'vCPU-h', capacity: 5_840, fixedMonthly: 46_000, base: 0.33, stoppedFrom: '2026-05', stoppedSpend: 9_500, environment: 'test', startDate: '2024-09-01',
    note: 'Stopped in May 2026 after the MES go-live; managed disks remain attached and billed.',
  },
  {
    id: 'SV-CL-04', name: 'CFD GPU instances — g5.12xlarge on-demand', provider: 'Amazon Web Services', category: 'cloud', subType: 'gpu', deptId: 'sim', owner: 'u-sneha',
    billing: 'on-demand', unit: 'GPU-h', capacity: 2_880, fixedMonthly: 3_40_000, base: 0.8, trend: 0.004, limitAtCapacity: 0.85, blockedPerHit: 4, spikes: { '2026-09': 1.15, '2026-03': 1.1 },
    environment: 'prod', startDate: '2025-02-01', note: 'Account GPU quota is 4 instances; jobs queue when it is reached.',
  },
  {
    id: 'SV-CL-05', name: 'A100 GPU node — 1-yr reserved (8 GPU)', provider: 'Microsoft Azure', category: 'cloud', subType: 'gpu', deptId: 'rnd', owner: 'u-anjali',
    billing: 'reserved', unit: 'GPU-h', capacity: 5_840, fixedMonthly: 5_10_000, base: 0.34, environment: 'prod', startDate: '2026-03-01', renewalDate: '2027-02-28', renewalKind: 'reservation ends',
    note: 'Model training for compressor diagnostics research.',
  },
  {
    id: 'SV-CL-06', name: 'Cloud rendering workstations — NV36ads A10', provider: 'Microsoft Azure', category: 'cloud', subType: 'gpu', deptId: 'design', owner: 'u-meera',
    billing: 'on-demand', unit: 'GPU-h', capacity: 1_460, fixedMonthly: 96_000, base: 0.11, environment: 'prod', startDate: '2025-06-01', note: 'Left running between marketing render jobs.',
  },
  {
    id: 'SV-CL-07', name: 'Azure SQL — licence & usage telemetry (8 vCore)', provider: 'Microsoft Azure', category: 'cloud', subType: 'database', deptId: 'it', owner: 'u-priya',
    billing: 'on-demand', unit: 'vCore-h', capacity: 5_840, fixedMonthly: 72_000, base: 0.47, trend: 0.004, environment: 'prod', startDate: '2024-08-01',
  },
  {
    id: 'SV-CL-08', name: 'RDS PostgreSQL — test-rig data', provider: 'Amazon Web Services', category: 'cloud', subType: 'database', deptId: 'rnd', owner: 'u-arjun',
    billing: 'on-demand', unit: 'vCPU-h', capacity: 2_920, fixedMonthly: 38_000, base: 0.16, environment: 'test', startDate: '2025-03-01',
  },
  {
    id: 'SV-CL-09', name: 'Cosmos DB serverless — compressor IoT telemetry', provider: 'Microsoft Azure', category: 'cloud', subType: 'database', deptId: 'engg', owner: 'u-kavita',
    billing: 'payg', unit: 'M RU', unitPrice: 23, base: 2_400, trend: 0.014, environment: 'prod', startDate: '2025-05-01', note: 'Serverless: billed per request unit consumed.',
  },
  {
    id: 'SV-CL-10', name: 'Blob storage — simulation results archive', provider: 'Microsoft Azure', category: 'cloud', subType: 'storage', deptId: 'sim', owner: 'u-harish',
    billing: 'payg', unit: 'TB-month', unitPrice: 1_650, base: 48, trend: 0.02, environment: 'prod', startDate: '2024-04-01', note: 'Object storage billed on data stored.',
  },
  {
    id: 'SV-CL-11', name: 'Premium file share — CAD vault replica (10 TB)', provider: 'Microsoft Azure', category: 'cloud', subType: 'storage', deptId: 'design', owner: 'u-meera',
    billing: 'on-demand', unit: 'TB', capacity: 10, fixedMonthly: 1_25_000, base: 0.41, trend: 0.004, environment: 'prod', startDate: '2024-10-01', note: 'Provisioned size is billed whether or not it is filled.',
  },
  {
    id: 'SV-CL-12', name: 'Unattached managed disks and old snapshots', provider: 'Microsoft Azure', category: 'cloud', subType: 'storage', deptId: null, owner: 'u-neha',
    billing: 'on-demand', unit: 'TB', capacity: 6, fixedMonthly: 42_000, base: 0, environment: 'shared', startDate: '2025-01-01', note: 'Left behind by deleted VMs; not attached to any machine.',
  },
];

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function last4For(seed: string): string {
  const r = mulberry32(hashString(`key:${seed}`));
  return Array.from({ length: 4 }, () => ALNUM[Math.floor(r() * ALNUM.length)]).join('');
}

/** Masked identifier: provider prefix, bullets, last four characters. */
export function maskKey(prefix: string, last4: string): string {
  return `${prefix}••••${last4}`;
}

function buildMonths(s: Seed, months: MonthKey[]): ServiceMonth[] {
  const r = mulberry32(hashString(`svc:${s.id}`));
  const basis = BASIS[s.billing];
  const start = s.startDate ? monthKey(s.startDate) : months[0];
  const n = months.length;
  return months.map((m, i) => {
    const age = i - (n - 1); // 0 for the current month, negative before
    const seasonal = 1 + 0.06 * Math.sin((2 * Math.PI * (i + 3)) / 12);
    const noise = 1 + 0.06 * gauss(r);
    const spike = s.spikes?.[m] ?? 1;
    const growth = Math.max(0.3, 1 + (s.trend ?? 0) * age);
    if (m < start) return { month: m, usage: 0, capacity: basis === 'consumption' ? null : 0, spend: 0, idle: 0, quotaHits: 0, blockedHours: 0 };

    if (basis === 'consumption') {
      const usage = Math.max(0, s.base * growth * seasonal * noise * spike);
      const spend = usage * (s.unitPrice ?? 0);
      let hits = 0;
      if (s.quota && usage > s.quota * 0.9) hits = Math.round((usage / s.quota - 0.9) * 120);
      return { month: m, usage, capacity: null, spend, idle: 0, quotaHits: hits, blockedHours: hits * (s.blockedPerHit ?? 0) };
    }

    const cap = s.capacity ?? 0;
    if (s.stoppedFrom && m >= s.stoppedFrom) {
      // Stopped VM: no compute used; only the attached disks are billed, all of it idle.
      return { month: m, usage: 0, capacity: cap, spend: s.stoppedSpend ?? 0, idle: s.stoppedSpend ?? 0, quotaHits: 0, blockedHours: 0 };
    }
    const share = Math.max(0, s.base * growth * seasonal * noise * spike);
    if (basis === 'commitment') {
      const usage = share * cap;
      const within = Math.min(usage, cap);
      const overage = Math.max(0, usage - cap) * (s.unitPrice ?? 0);
      const spend = (s.fixedMonthly ?? 0) + overage;
      const idle = (s.fixedMonthly ?? 0) * (1 - within / cap);
      const hits = s.limitAtCapacity && share > s.limitAtCapacity ? Math.round((share - s.limitAtCapacity) * 250) : 0;
      return { month: m, usage, capacity: cap, spend, idle, quotaHits: hits, blockedHours: hits * (s.blockedPerHit ?? 0) };
    }
    // provisioned: billed for the capacity provisioned; busy share from telemetry
    const busy = Math.min(1, share);
    const spend = (s.fixedMonthly ?? 0) * (1 + 0.015 * gauss(r));
    const hits = s.limitAtCapacity && share > s.limitAtCapacity ? Math.round((share - s.limitAtCapacity) * 250) : 0;
    return { month: m, usage: busy * cap, capacity: cap, spend, idle: spend * (1 - busy), quotaHits: hits, blockedHours: hits * (s.blockedPerHit ?? 0) };
  });
}

let cached: ServiceRecord[] | null = null;

export function getServices(): ServiceRecord[] {
  if (cached) return cached;
  const months = monthsBack(SERVICES_CURRENT_MONTH, SERVICE_MONTHS);
  cached = SEEDS.map((s) => {
    const keys: ServiceKey[] = (s.keySeeds ?? []).map((k, i) => {
      const last4 = last4For(`${s.id}-${i}`);
      return { id: `${s.id}-K${i + 1}`, label: k.label, masked: maskKey(s.keyPrefix ?? 'key_', last4), last4, ownerUserId: k.ownerUserId, environment: k.environment, created: k.created, lastUsed: k.lastUsed, expires: k.expires, calls30d: k.calls30d };
    });
    return {
      id: s.id,
      name: s.name,
      provider: s.provider,
      category: s.category,
      subType: s.subType,
      deptId: s.deptId,
      ownerUserId: s.owner,
      billing: s.billing,
      basis: BASIS[s.billing],
      unit: s.unit,
      capacity: s.capacity ?? null,
      quota: s.quota ?? null,
      unitPrice: s.unitPrice ?? 0,
      fixedMonthly: s.fixedMonthly ?? 0,
      environment: s.environment ?? 'prod',
      startDate: s.startDate ?? `${addMonths(SERVICES_CURRENT_MONTH, -(SERVICE_MONTHS - 1))}-01`,
      renewalDate: s.renewalDate ?? null,
      renewalKind: s.renewalKind ?? null,
      note: s.note,
      keys,
      months: buildMonths(s, months),
    };
  });
  return cached;
}
