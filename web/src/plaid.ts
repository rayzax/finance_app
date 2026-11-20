import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from './api';

/**
 * start()          -> link a new account
 * start(itemId)    -> update mode (Reconnect); on success we just trigger a sync
 */
export function usePlaid() {
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
          await api('/api/sync', { method: 'POST' });
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
