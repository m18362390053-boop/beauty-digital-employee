import { AccessControl } from '../server/access.js';
import type { Store } from '../server/storage/store.js';

export const testOperatorPassword = 'test-only-operator-password';
export const testAccess = (store: Store) => new AccessControl(store, { operatorPassword: testOperatorPassword });
export async function loginOperator(base: string) {
  const response = await fetch(base + '/api/auth/operator/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: testOperatorPassword }) });
  if (!response.ok) throw new Error(`Test operator login failed: ${response.status}`);
  const body = await response.json() as { csrfToken: string };
  return { Cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token': body.csrfToken };
}
