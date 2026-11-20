import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from './api';

/**
 * start()          -> link a new account
 * start(itemId)    -> update mode (Reconnect); on success we sync that item (never debounced)
 */
function usePlaidImpl() {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemRef = useRef<string | undefined>(undefined);

  const onSuccess = useCallback(
    async (publicToken: string | null, meta: PlaidLinkOnSuccessMetadata) => {
      setBusy(true);
      try {
        if (itemRef.current) {
          await api(`/api/items/${encodeURIComponent(itemRef.current)}/sync`, { method: 'POST' });
        } else {
          await api('/api/plaid/exchange', {
            method: 'POST',
            body: {
              public_token: publicToken ?? '',
              institution: { institution_id: meta.institution?.institution_id ?? '', name: meta.institution?.name ?? 'Institution' },
            },
          });
        }
        await qc.invalidateQueries();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(false);
        setToken(null);
      }
    },
    [qc],
  );

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
    onExit: (err) => {
      if (err) setError(err.display_message || err.error_message || 'Plaid Link closed with an error');
      setToken(null);
    },
  });

  useEffect(() => {
    if (token && ready) open();
  }, [token, ready, open]);

  const start = useCallback(async (itemId?: string) => {
    setError(null);
    setBusy(true);
    try {
      itemRef.current = itemId;
      const r = await api<{ link_token: string }>('/api/plaid/link-token', { method: 'POST', body: itemId ? { itemId } : {} });
      setToken(r.link_token);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { start, busy, error, clearError: () => setError(null) };
}

// One Plaid Link instance for the whole app: usePlaidLink injects Plaid's script on every mount,
// and loading it more than once is unsupported.
type PlaidApi = ReturnType<typeof usePlaidImpl>;
const PlaidContext = createContext<PlaidApi | null>(null);

export function PlaidProvider({ children }: { children: ReactNode }) {
  return createElement(PlaidContext.Provider, { value: usePlaidImpl() }, children);
}

export function usePlaid(): PlaidApi {
  const v = useContext(PlaidContext);
  if (!v) throw new Error('usePlaid must be used inside PlaidProvider');
  return v;
}
