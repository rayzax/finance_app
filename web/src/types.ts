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

export type RecurringStatus = 'paid' | 'due_soon' | 'upcoming' | 'overdue';
export interface RecurringItem {
  id: string;
  name: string;
  amount: number;
  dayOfMonth: number;
  category: string;
  categoryLabel: string;
  matchMerchant: string | null;
  active: boolean;
  dueDate: string;
  status: RecurringStatus;
  paidTxId: string | null;
  paidDate: string | null;
}
export interface DetectedStream {
  streamId: string;
  description: string;
  averageAmount: number;
  frequency: string;
  predictedNextDate: string | null;
  lastDate: string | null;
}
export interface RecurringCosts {
  month: string;
  totalMonthly: number;
  paidCount: number;
  paidAmount: number;
  upcomingCount: number;
  upcomingAmount: number;
  items: RecurringItem[];
  detected: DetectedStream[];
}

export type GoalPace = 'ahead' | 'on_track' | 'behind' | 'done' | 'no_date';
export interface Goal {
  id: string;
  name: string;
  targetAmount: number;
  targetDate: string | null;
  source: 'accounts' | 'manual';
  accountIds: string[];
  current: number;
  pct: number;
  remaining: number;
  monthlyNeeded: number | null;
  expectedPct: number | null;
  pace: GoalPace;
  projectedDate: string | null;
  countOnlyNew: boolean;
  manualAmount: number;
  createdAt: string;
}
export interface GoalsResponse {
  goals: Goal[];
  summary: { totalSaved: number; totalTarget: number; onTrack: number; behind: number };
}

export type Role = 'admin' | 'member';
export interface AuthUser { id: string; username: string; displayName: string; initials: string; role: Role }
export interface Me { authenticated: true; user: AuthUser; mustChangePassword: boolean }
export interface Person {
  id: string; username: string; displayName: string; role: Role;
  totpEnabled: boolean; disabled: boolean; lastLoginAt: string | null; createdAt: string;
}
