import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { getConfig } from './config';

let client: PlaidApi | undefined;
export function plaid(): PlaidApi {
  if (!client) {
    const cfg = getConfig();
    client = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[cfg.plaidEnv],
        baseOptions: {
          headers: {
            'PLAID-CLIENT-ID': cfg.plaidClientId,
            'PLAID-SECRET': cfg.plaidSecret,
            'Plaid-Version': '2020-09-14',
          },
        },
      }),
    );
  }
  return client;
}

export interface RedactedError {
  error_type?: string;
  error_code?: string;
  request_id?: string;
  status?: number;
  message?: string;
}

/**
 * Reduce any error to a loggable shape. Plaid SDK (axios) errors embed request
 * config including secrets and access tokens, so the raw error is never logged.
 */
export function redactPlaidError(err: unknown): RedactedError {
  const e = err as any;
  const data = e?.response?.data;
  if (data && typeof data === 'object') {
    return {
      error_type: data.error_type,
      error_code: data.error_code,
      request_id: data.request_id,
      status: e.response?.status,
    };
  }
  return { status: e?.response?.status, message: typeof e?.message === 'string' ? e.message.slice(0, 200) : 'unknown error' };
}

export const plaidErrorCode = (err: unknown): string | undefined => (err as any)?.response?.data?.error_code;

export function logPlaidError(context: string, err: unknown): void {
  console.error(`[plaid] ${context}`, JSON.stringify(redactPlaidError(err)));
}
