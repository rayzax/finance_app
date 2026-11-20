import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { AccountsResponse, Budgets, Cashflow, Category, GoalsResponse, Range, RecurringCosts, Summary, TxPage } from './types';

export const useSummary = (range: Range) =>
  useQuery({
    queryKey: ['summary', range],
    queryFn: () => api<Summary>(`/api/summary?range=${range}`),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

export const useAccounts = () =>
  useQuery({ queryKey: ['accounts'], queryFn: () => api<AccountsResponse>('/api/accounts'), staleTime: 60_000 });

export const useBudgets = (month: string) =>
  useQuery({
    queryKey: ['budgets', month],
    queryFn: () => api<Budgets>(`/api/budgets?month=${month}`),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

export const useCashflow = () =>
  useQuery({ queryKey: ['cashflow'], queryFn: () => api<Cashflow>('/api/cashflow'), staleTime: 5 * 60_000 });

export const useRecurringCosts = (month: string) =>
  useQuery({
    queryKey: ['recurring', month],
    queryFn: () => api<RecurringCosts>(`/api/recurring-costs?month=${month}`),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

export const useGoals = () =>
  useQuery({ queryKey: ['goals'], queryFn: () => api<GoalsResponse>('/api/goals'), staleTime: 60_000 });

export const useCategories = () =>
  useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/api/categories'), staleTime: Infinity });

export const useTransactions = (kind: string, q: string) =>
  useInfiniteQuery({
    queryKey: ['transactions', kind, q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (kind) p.set('kind', kind);
      if (q) p.set('q', q);
      if (pageParam) p.set('before', pageParam);
      return api<TxPage>(`/api/transactions?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });

export function useSyncAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean; skipped?: boolean; lastSyncAt: string | null }>('/api/sync', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries(),
  });
}
