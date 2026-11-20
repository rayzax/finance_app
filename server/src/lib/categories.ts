export type Kind = 'spend' | 'income' | 'transfer';
export type Group = 'cash' | 'investments' | 'retirement' | 'credit' | 'loans' | 'other';

export interface CategoryDef { key: string; label: string; kind: Kind }

export const CATEGORIES: CategoryDef[] = [
  { key: 'groceries', label: 'Groceries', kind: 'spend' },
  { key: 'dining', label: 'Dining out', kind: 'spend' },
  { key: 'transport', label: 'Transport', kind: 'spend' },
  { key: 'shopping', label: 'Shopping', kind: 'spend' },
  { key: 'bills', label: 'Bills & utilities', kind: 'spend' },
  { key: 'home', label: 'Home', kind: 'spend' },
  { key: 'health', label: 'Health', kind: 'spend' },
  { key: 'personal', label: 'Personal care', kind: 'spend' },
  { key: 'entertainment', label: 'Entertainment', kind: 'spend' },
  { key: 'travel', label: 'Travel', kind: 'spend' },
  { key: 'services', label: 'Services', kind: 'spend' },
  { key: 'giving', label: 'Gifts & giving', kind: 'spend' },
  { key: 'fees', label: 'Fees', kind: 'spend' },
  { key: 'loans', label: 'Loan payments', kind: 'spend' },
  { key: 'other', label: 'Other', kind: 'spend' },
  { key: 'income', label: 'Income', kind: 'income' },
  { key: 'transfer', label: 'Transfer', kind: 'transfer' },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
export const isCategoryKey = (k: string): boolean => BY_KEY.has(k);
export const categoryLabel = (k: string): string => BY_KEY.get(k)?.label ?? 'Other';
export const SPEND_CATEGORIES = CATEGORIES.filter((c) => c.kind === 'spend');

const PRIMARY_MAP: Record<string, string> = {
  TRANSPORTATION: 'transport',
  GENERAL_MERCHANDISE: 'shopping',
  RENT_AND_UTILITIES: 'bills',
  HOME_IMPROVEMENT: 'home',
  MEDICAL: 'health',
  PERSONAL_CARE: 'personal',
  ENTERTAINMENT: 'entertainment',
  TRAVEL: 'travel',
  GENERAL_SERVICES: 'services',
  GOVERNMENT_AND_NON_PROFIT: 'giving',
  BANK_FEES: 'fees',
  LOAN_PAYMENTS: 'loans',
  INCOME: 'income',
  TRANSFER_IN: 'transfer',
  TRANSFER_OUT: 'transfer',
};

/** Plaid personal finance category -> our category key. */
export function mapCategory(primary?: string | null, detailed?: string | null): string {
  const p = (primary ?? '').toUpperCase();
  const d = (detailed ?? '').toUpperCase();
  if (p === 'FOOD_AND_DRINK') return d === 'FOOD_AND_DRINK_GROCERIES' ? 'groceries' : 'dining';
  if (p === 'LOAN_PAYMENTS' && d === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') return 'transfer';
  return PRIMARY_MAP[p] ?? 'other';
}

export function kindOf(category: string): Kind {
  return BY_KEY.get(category)?.kind ?? 'spend';
}

const RETIREMENT_SUBTYPES = new Set([
  '401k', '401a', '403b', '457b', 'ira', 'roth', 'roth 401k', 'sep ira', 'simple ira',
  'pension', 'retirement', 'keogh', 'thrift savings plan',
]);

export function accountGroup(type?: string | null, subtype?: string | null): Group {
  switch ((type ?? '').toLowerCase()) {
    case 'depository': return 'cash';
    case 'credit': return 'credit';
    case 'loan': return 'loans';
    case 'investment':
      return RETIREMENT_SUBTYPES.has((subtype ?? '').toLowerCase()) ? 'retirement' : 'investments';
    default: return 'other';
  }
}

export const LIABILITY_GROUPS: ReadonlySet<Group> = new Set<Group>(['credit', 'loans']);
export const GROUP_ORDER: Group[] = ['cash', 'investments', 'retirement', 'credit', 'loans', 'other'];
export const GROUP_LABELS: Record<Group, string> = {
  cash: 'Cash', investments: 'Investments', retirement: 'Retirement',
  credit: 'Credit cards', loans: 'Loans', other: 'Other',
};

/** Stable Firestore-safe document id for a merchant rule. */
export function normalizeMerchant(name?: string | null): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}
