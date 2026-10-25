import { StatusChip } from '../../components/ui/StatusChip';
import type { ReviewRecord } from '../../domain/types';

export const KIND_LABEL: Record<ReviewRecord['kind'], string> = {
  reduction: 'Reduce at renewal',
  'token-mix': 'Move to tokens',
  reallocation: 'Re-host / reallocate',
  temporary: 'Temporary access',
  purchase: 'Purchase',
};

export function outcomeChip(r: ReviewRecord) {
  switch (r.state) {
    case 'awaiting-implementation':
      return <StatusChip status="pending">Awaiting implementation</StatusChip>;
    case 'awaiting-invoice':
      return <StatusChip status="unverified">Awaiting invoice</StatusChip>;
    case 'verified':
      return <StatusChip status="verified">Verified</StatusChip>;
    case 'verified-cost-avoided':
      return <StatusChip status="verified">Verified · cost avoided</StatusChip>;
    case 'partly-verified':
      return <span className="chip warn dashed">Partly verified</span>;
    case 'not-implemented':
      return <StatusChip status="not-implemented">Not implemented</StatusChip>;
  }
}
