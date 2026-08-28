import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Authorization for the control plane: the routes that change a case, spend Pincc credits, or
 * republish the figures a judge is reading. The webhook is not one of them — it carries a provider
 * HMAC and must stay reachable without a bearer token.
 *
 * A missing token means the control plane is disabled, never open. A public instance that forgot to
 * configure one would otherwise hand every visitor the same buttons the operator has.
 */
export function authorizedControlRequest(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined || token === '') return false;
  const header = request.headers.authorization;
  const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (presented === undefined) return false;
  // Digesting first makes both sides 32 bytes, so the comparison cannot leak the token's length.
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(createHash('sha256').update(presented).digest(), expected);
}
