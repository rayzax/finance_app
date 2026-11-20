export type Group = 'cash' | 'investments' | 'retirement' | 'credit' | 'loans' | 'other';
export type ItemStatus = 'ok' | 'login_required' | 'error';
export type Range = '1M' | '3M' | '1Y' | 'ALL';

export interface Summary {
  netWorth: number;
  assets: number;
  liabilities: number;
  delta: number;
  deltaLabel: string;
  series: { date: string; value: number }[];
  groups: { group: Group; label: string; total: number; count: number; subtitle: string }[];
  lastSyncAt: string | null;
  hasAccounts: boolean;
}

export interface Account {
  id: string;
  itemId: string;
  institutionName: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  group: Group;
  current: number | null;
  available: number | null;
  limit: number | null;
  currency: string;
  hidden: boolean;
}
export interface AccountItem {
  id: string;
  institutionName: string;
  status: ItemStatus;
  error: string | null;
  lastSyncAt: string | null;
  newAccountsAvailable: boolean;
}
export interface AccountsResponse {
  groups: { group: Group; label: string; total: number; accounts: Account[] }[];
  items: AccountItem[];
}

export interface Tx {
  id: string;
  date: string;
  name: string;
  merchantName: string | null;
  amount: number;
  category: string;
  categoryLabel: string;
  kind: 'spend' | 'income' | 'transfer';
  pending: boolean;
  logoUrl: string | null;
  accountId: string;
  accountName: string;
  userCategory: boolean;
}
export interface TxPage {
  days: { date: string; label: string; items: Tx[] }[];
  nextCursor: string | null;
  monthSpent: number;
  monthEarned: number;
  month: string;
}

export interface BudgetCategory {
  key: string;
  label: string;
  limit: number | null;
  spent: number;
  over: boolean;
}
export interface Budgets {
  limit: number;
  spent: number;
  left: number;
  pct: number;
  daysLeft: number;
  categories: BudgetCategory[];
}

export interface Cashflow {
  asOf: string;
  horizonDate: string;
  cashNow: number;
  projected: number;
  bills: number;
  paydays: number;
  upcoming: { date: string; description: string; amount: number; direction: 'in' | 'out' }[];
  weekly: { weekStart: string; value: number; projected: boolean }[];
}

export interface Category {
  key: string;
  label: string;
}
