import { fallbackLinkState, isTerminal, type RecoveryCase } from './domain.js';

/**
 * The customer-facing fallback message, as it would be sent. The MVP previews it and stops
 * there: no email, SMS, WhatsApp, or voice provider is integrated, so `deliverable` is always
 * false and nothing here is a send. The preview names the renewal and the provider's own link
 * reference — it never carries payment credentials, provider payment ids, or gateway telemetry,
 * and it never synthesizes a link URL the provider did not return.
 */
export interface FallbackMessagePreview {
  readonly customerId: string;
  readonly subject: string;
  readonly body: string;
  readonly linkReference: string;
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly deliverable: false;
}

/** Minor currency units as the customer reads them: 129900 INR minor units is `INR 1299.00`. */
function money(amount: number, currency: string): string {
  return `${currency} ${(amount / 100).toFixed(2)}`;
}

/**
 * The message for the fallback link on this case, or undefined when there is nothing honest to
 * ask a customer for: no link was created, the provider never returned one, the renewal is
 * already paid, or the case has reached an outcome. A succeeded attempt is checked directly
 * rather than through the case status, because a renewal paid outside the loop stands the case
 * down to `stopped` and never reaches `recovered` — and that customer must not be asked to pay
 * again either. The link itself comes from the same rule policy and the expiry sweep use.
 */
export function fallbackRecoveryMessage(recoveryCase: RecoveryCase, now: string): FallbackMessagePreview | undefined {
  if (recoveryCase.recoveredAmount > 0 || recoveryCase.attempts.some((attempt) => attempt.status === 'succeeded')) return undefined;
  if (isTerminal(recoveryCase.status)) return undefined;
  // `fallbackLinkState` only recognizes a link that records an expiry, which is the same link
  // policy will act on. A link without one is not offered to a customer at all.
  const state = fallbackLinkState(recoveryCase, now);
  if (state === undefined) return undefined;
  const link = state.action;
  if (!link.expiresAt || !link.providerReference || link.status === 'pending') return undefined;
  const { amount, currency, subscriptionId } = recoveryCase.context;
  const expired = !state.live;
  const amountDue = money(amount, currency);
  const validity = expired
    ? `The payment link expired at ${link.expiresAt} and can no longer be used.`
    : `The payment link is valid until ${link.expiresAt}.`;
  return {
    customerId: recoveryCase.context.customerId,
    subject: `Complete your ${subscriptionId} renewal of ${amountDue}`,
    body: [
      `Your renewal for ${subscriptionId} of ${amountDue} could not be collected.`,
      `You can complete the same renewal — the amount and currency are unchanged — through payment link ${link.providerReference}.`,
      validity,
    ].join('\n\n'),
    linkReference: link.providerReference,
    expiresAt: link.expiresAt,
    expired,
    deliverable: false,
  };
}
