import { Firestore } from '@google-cloud/firestore';
import { getConfig } from './config';

let fs: Firestore | undefined;
export function db(): Firestore {
  if (!fs) {
    const cfg = getConfig();
    fs = new Firestore({
      databaseId: process.env.FIRESTORE_DATABASE || 'finance',
      ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
      ignoreUndefinedProperties: true,
    });
  }
  return fs;
}

export const col = {
  items: () => db().collection('items'),
  accounts: () => db().collection('accounts'),
  transactions: () => db().collection('transactions'),
  merchantRules: () => db().collection('merchantRules'),
  snapshots: () => db().collection('snapshots'),
  recurring: () => db().collection('recurring'),
  settings: () => db().collection('settings'),
  recurringCosts: () => db().collection('recurringCosts'),
  goals: () => db().collection('goals'),
};

export type ItemStatus = 'ok' | 'login_required' | 'error';

export interface ItemDoc {
  institutionId?: string;
  institutionName: string;
  accessTokenEnc: string;
  cursor?: string | null;
  status: ItemStatus;
  error: string | null;
  newAccountsAvailable?: boolean;
  createdAt: string;
  lastSyncAt: string | null;
}

export interface AccountDoc {
  itemId: string;
  institutionName: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  group: string;
  current: number;
  available: number | null;
  limit: number | null;
  currency: string;
  hidden: boolean;
  updatedAt: string;
}

export interface TransactionDoc {
  itemId: string;
  accountId: string;
  date: string;
  month: string;
  name: string;
  merchantName: string | null;
  amount: number;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  category: string;
  userCategory: string | null;
  kind: 'spend' | 'income' | 'transfer';
  pending: boolean;
  logoUrl: string | null;
  updatedAt: string;
}

export interface RecurringCostDoc {
  name: string;
  amount: number;
  dayOfMonth: number;
  category: string;
  matchMerchant: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GoalDoc {
  name: string;
  targetAmount: number;
  targetDate: string | null;
  source: 'accounts' | 'manual';
  accountIds: string[];
  /** Sum of the linked accounts' balances when "count only new savings" was chosen; null otherwise. */
  startingBalance: number | null;
  manualAmount: number;
  contributions: { date: string; amount: number }[];
  createdAt: string;
  archived: boolean;
}

/** Delete every doc matching a query in batches of <=400. */
export async function deleteQuery(q: FirebaseFirestore.Query): Promise<number> {
  let total = 0;
  for (;;) {
    const snap = await q.limit(400).get();
    if (snap.empty) return total;
    const batch = db().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
  }
}
