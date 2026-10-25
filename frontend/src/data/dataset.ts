import type {
  Department,
  Licence,
  MonthlyUsage,
  NamedAssignment,
  Project,
  User,
  UserToolUsage,
  Vendor,
  WeeklyDemand,
} from '../domain/types';
import { VENDORS } from './catalog';
import { generateDataset } from './generate';

export interface Dataset {
  departments: Department[];
  vendors: Vendor[];
  licences: Licence[];
  projects: Project[];
  users: User[];
  weekly: WeeklyDemand[];
  monthly: MonthlyUsage[];
  assignments: NamedAssignment[];
  userUsage: UserToolUsage[];
}

let cached: Dataset | null = null;

/** The immutable sample dataset. Generated once, deterministically. */
export function getBaseDataset(): Dataset {
  if (!cached) cached = { ...generateDataset(), vendors: VENDORS };
  return cached;
}
