import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentAttempt, ProviderEvent, RecoveryAction, RecoveryCase } from './domain.js';

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date { return new Date(); }
}

export class FixedClock implements Clock {
  private current: Date;
  constructor(value: string | Date) { this.current = new Date(value); }
  now(): Date { return new Date(this.current); }
  advance(milliseconds: number): void { this.current = new Date(this.current.getTime() + milliseconds); }
}

export interface NormalizedEventInput {
  readonly id: string;
  readonly type: ProviderEvent['type'];
  readonly caseId: string;
  readonly providerPaymentId?: string;
  readonly occurredAt: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface RetryEligibility {
  readonly eligible: boolean;
  readonly reason: string;
}

export interface ProviderResult {
  readonly providerReference?: string;
  readonly status: 'submitted' | 'succeeded' | 'failed';
  readonly message: string;
  /** True when the provider recognized this action identity and did not perform a second operation. */
  readonly idempotent?: boolean;
}

export type FallbackLinkResult = ProviderResult & { readonly expiresAt: string };

/**
 * The single contract recovery orchestration depends on. The deterministic simulator and the
 * Razorpay Test Mode adapter implement it identically, and the shared contract tests run
 * against both. Actions are keyed by `RecoveryAction.idempotencyKey`: submitting the same
 * identity twice must never perform a second money operation.
 */
export interface PaymentProvider {
  verifyEvent(raw: string, signature: string): boolean;
  normalizeEvent(input: NormalizedEventInput, receivedAt: string): ProviderEvent;
  retryEligibility(recoveryCase: RecoveryCase): Promise<RetryEligibility>;
  submitRetry(recoveryCase: RecoveryCase, action: RecoveryAction): Promise<ProviderResult>;
  createFallbackLink(recoveryCase: RecoveryCase, action: RecoveryAction): Promise<FallbackLinkResult>;
}

const FALLBACK_LINK_TTL_SECONDS = 24 * 60 * 60;

/**
 * The attempt a retry would charge again, or undefined when the case offers none. Both providers
 * decide eligibility with this one rule, so the contract cannot drift between them: a case with a
 * succeeded attempt is already paid and may not be charged, and the target is the latest failed
 * mandate attempt rather than the oldest one on record.
 */
export function chargeableMandateAttempt(recoveryCase: RecoveryCase): PaymentAttempt | undefined {
  if (recoveryCase.attempts.some((attempt) => attempt.status === 'succeeded')) return undefined;
  return [...recoveryCase.attempts].reverse().find((attempt) => attempt.method === 'recurring_mandate' && attempt.status === 'failed' && Boolean(attempt.providerPaymentId));
}

export interface SimulatorScenario {
  readonly retry: 'success' | 'failure' | 'unsupported';
  readonly fallback: 'success' | 'failure';
  readonly diagnosis: 'transient' | 'hard_decline' | 'low_confidence' | 'malformed';
}

export class DeterministicSimulator implements PaymentProvider {
  private readonly scenarios: ReadonlyMap<string, SimulatorScenario>;
  private readonly results = new Map<string, ProviderResult>();
  readonly calls: RecoveryAction[] = [];

  constructor(
    scenarios: ReadonlyMap<string, SimulatorScenario> = new Map(),
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.scenarios = scenarios;
  }

  verifyEvent(raw: string, signature: string): boolean {
    return raw.length > 0 && signature === `sim:${raw}`;
  }

  normalizeEvent(input: NormalizedEventInput, receivedAt: string): ProviderEvent {
    const payload = input.payload ?? {};
    return {
      id: input.id,
      type: input.type,
      caseId: input.caseId,
      ...(input.providerPaymentId === undefined ? {} : { providerPaymentId: input.providerPaymentId }),
      occurredAt: input.occurredAt,
      receivedAt,
      payload,
    };
  }

  async retryEligibility(recoveryCase: RecoveryCase): Promise<RetryEligibility> {
    if (chargeableMandateAttempt(recoveryCase) === undefined) return { eligible: false, reason: 'No failed authorized recurring mandate is available to charge again' };
    const scenario = this.scenarios.get(recoveryCase.id);
    if (scenario?.retry === 'unsupported') return { eligible: false, reason: 'The provider does not support retry for this mandate' };
    return { eligible: true, reason: 'Authorized recurring mandate is eligible' };
  }

  async submitRetry(recoveryCase: RecoveryCase, action: RecoveryAction): Promise<ProviderResult> {
    const replayed = this.replay(action);
    if (replayed) return replayed;
    this.calls.push(action);
    const scenario = this.scenarios.get(recoveryCase.id);
    const result: ProviderResult = scenario?.retry === 'failure'
      ? { status: 'failed', message: 'Simulated retry failure' }
      : { status: 'succeeded', providerReference: `sim_retry_${recoveryCase.id}`, message: 'Simulated retry succeeded' };
    this.results.set(action.idempotencyKey, result);
    return result;
  }

  async createFallbackLink(recoveryCase: RecoveryCase, action: RecoveryAction): Promise<FallbackLinkResult> {
    const replayed = this.replay(action);
    const expiresAt = new Date(this.clock.now().getTime() + FALLBACK_LINK_TTL_SECONDS * 1000).toISOString();
    if (replayed) return { ...replayed, expiresAt: (replayed as FallbackLinkResult).expiresAt ?? expiresAt };
    this.calls.push(action);
    const scenario = this.scenarios.get(recoveryCase.id);
    const result: FallbackLinkResult = scenario?.fallback === 'failure'
      ? { status: 'failed', message: 'Simulated fallback-link failure', expiresAt }
      : { status: 'succeeded', providerReference: `sim_link_${recoveryCase.id}`, message: 'Simulated fallback link created', expiresAt };
    this.results.set(action.idempotencyKey, result);
    return result;
  }

  /** Replays a recorded result so a repeated action identity never performs a second operation. */
  private replay(action: RecoveryAction): ProviderResult | undefined {
    const previous = this.results.get(action.idempotencyKey);
    return previous === undefined ? undefined : { ...previous, idempotent: true };
  }
}

export interface RazorpayTestModeOptions {
  readonly keyId: string;
  readonly keySecret: string;
  /** Razorpay signs webhooks with the webhook secret, which is configured separately from the API key. */
  readonly webhookSecret?: string;
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly clock?: Clock;
}

/** Razorpay rejects a receipt or reference longer than this, so long action identities are folded. */
const REFERENCE_MAX_LENGTH = 40;

/** Razorpay payment states that mean money moved. `created` and `failed` did not charge anything. */
const LIVE_PAYMENT_STATUSES = ['authorized', 'captured', 'refunded'];

interface RazorpayResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly payload: Record<string, unknown>;
  /** Set when the request never reached Razorpay, so a transport failure reads differently from a decline. */
  readonly transportError?: string;
}

interface MandateIdentity {
  readonly tokenId: string;
  readonly customerId: string;
  readonly email: string;
  readonly contact: string;
}

/**
 * The live integration behind the same `PaymentProvider` contract the simulator implements.
 * It performs only operations Razorpay's public API documents: charging an existing authorized
 * recurring mandate again, and creating an expiring payment link. It never claims it can
 * recharge an arbitrary card payment, and it refuses to run against non-Test-Mode credentials.
 */
export class RazorpayTestModeProvider implements PaymentProvider {
  constructor(private readonly options: RazorpayTestModeOptions) {}

  /** The webhook signature Razorpay would send for this body. Exposed for contract tests. */
  signPayload(raw: string): string {
    return createHmac('sha256', this.webhookSecret()).update(raw).digest('hex');
  }

  verifyEvent(raw: string, signature: string): boolean {
    if (!raw || !signature || !this.webhookSecret()) return false;
    const supplied = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(this.signPayload(raw), 'utf8');
    return supplied.length === computed.length && timingSafeEqual(supplied, computed);
  }

  normalizeEvent(input: NormalizedEventInput, receivedAt: string): ProviderEvent {
    return {
      id: input.id,
      type: input.type,
      caseId: input.caseId,
      ...(input.providerPaymentId === undefined ? {} : { providerPaymentId: input.providerPaymentId }),
      occurredAt: input.occurredAt,
      receivedAt,
      payload: input.payload ?? {},
    };
  }

  async retryEligibility(recoveryCase: RecoveryCase): Promise<RetryEligibility> {
    return chargeableMandateAttempt(recoveryCase) === undefined
      ? { eligible: false, reason: 'Only provider-supported recurring mandates may be retried' }
      : { eligible: true, reason: 'Recurring mandate supplied by provider' };
  }

  /**
   * Charges the mandate behind the failed renewal again: read the original payment, refuse unless it
   * carries a recurring token, create or reuse an order keyed by the action identity, then charge.
   * Reusing the identity resolves the existing charge instead of making a second one, so an
   * infrastructure retry cannot collect the renewal twice.
   */
  async submitRetry(recoveryCase: RecoveryCase, action: RecoveryAction): Promise<ProviderResult> {
    const refusal = this.refusal();
    if (refusal) return { status: 'failed', message: refusal };
    const attempt = chargeableMandateAttempt(recoveryCase);
    // Razorpay's public API cannot recharge an arbitrary card payment; say so instead of pretending.
    if (attempt === undefined) return { status: 'failed', message: 'Retry is not supported for this payment: no authorized recurring mandate is on record' };

    const original = await this.call('GET', `/v1/payments/${encodeURIComponent(attempt.providerPaymentId)}`);
    if (!original.ok) return { status: 'failed', message: `Razorpay could not read the original payment ${attempt.providerPaymentId}: HTTP ${original.status}: ${this.describe(original)}` };
    const mandate = this.mandateOf(original.payload);
    if (mandate === undefined) return { status: 'failed', message: `Razorpay payment ${attempt.providerPaymentId} carries no authorized recurring mandate token, so it cannot be charged again` };

    const receipt = this.reference(action.idempotencyKey);
    const existingOrder = await this.findOrderByReceipt(receipt);
    if (existingOrder !== undefined) {
      const charged = await this.findPaymentOfOrder(existingOrder);
      if (charged !== undefined) return { status: 'submitted', providerReference: charged, message: 'Razorpay already holds a recurring charge for this action identity', idempotent: true };
    }
    const order = existingOrder ?? await this.createOrder(recoveryCase, receipt);
    if (typeof order !== 'string') return order;
    return this.chargeMandate(recoveryCase, order, mandate);
  }

  async createFallbackLink(recoveryCase: RecoveryCase, action: RecoveryAction): Promise<FallbackLinkResult> {
    const expiresAtSeconds = Math.floor(this.now().getTime() / 1000) + FALLBACK_LINK_TTL_SECONDS;
    const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();
    const refusal = this.refusal();
    if (refusal) return { status: 'failed', message: refusal, expiresAt };
    const reference = this.reference(action.idempotencyKey);
    // reference_id must be unique per link, so the action identity carries the idempotency:
    // a duplicate is rejected by Razorpay rather than creating a second link.
    const created = await this.call('POST', '/v1/payment_links', {
      amount: recoveryCase.context.amount,
      currency: recoveryCase.context.currency,
      reference_id: reference,
      expire_by: expiresAtSeconds,
      description: `Renewal recovery for order ${recoveryCase.context.orderId}`,
      notes: { caseId: recoveryCase.id, subscriptionId: recoveryCase.context.subscriptionId },
    });
    if (created.ok) {
      // A created link without an id means the response is not what the API documents.
      if (typeof created.payload.id !== 'string') return { status: 'failed', message: 'Razorpay returned a payment link without an id', expiresAt };
      return { status: 'submitted', providerReference: created.payload.id, message: 'Razorpay Test Mode payment link created', expiresAt };
    }
    const description = this.describe(created);
    if (created.status === 400 && /already exists/i.test(description)) {
      // The link already exists, so look up its real id rather than synthesizing one.
      const existing = await this.findLinkByReference(reference);
      return existing === undefined
        ? { status: 'submitted', message: 'Razorpay already holds a payment link for this action identity, but its id could not be resolved', expiresAt, idempotent: true }
        : { status: 'submitted', providerReference: existing, message: 'Razorpay already holds a payment link for this action identity', expiresAt, idempotent: true };
    }
    return { status: 'failed', message: `Razorpay payment-link request returned HTTP ${created.status}: ${description}`, expiresAt };
  }

  /** Submits the recurring charge itself. Its outcome arrives by webhook, not in this response. */
  private async chargeMandate(recoveryCase: RecoveryCase, orderId: string, mandate: MandateIdentity): Promise<ProviderResult> {
    const charge = await this.call('POST', '/v1/payments/create/recurring', {
      email: mandate.email,
      contact: mandate.contact,
      amount: recoveryCase.context.amount,
      currency: recoveryCase.context.currency,
      order_id: orderId,
      customer_id: mandate.customerId,
      token: mandate.tokenId,
      recurring: '1',
      description: `Renewal recovery for order ${recoveryCase.context.orderId}`,
    });
    if (!charge.ok) return { status: 'failed', message: `Razorpay recurring charge returned HTTP ${charge.status}: ${this.describe(charge)}` };
    const paymentId = charge.payload.razorpay_payment_id;
    // A charge without a payment id is not the documented response, so nothing may be called submitted.
    return typeof paymentId === 'string'
      ? { status: 'submitted', providerReference: paymentId, message: 'Razorpay Test Mode recurring charge submitted against the authorized mandate' }
      : { status: 'failed', message: 'Razorpay accepted the recurring charge without returning a payment id' };
  }

  /** Creates the order the recurring charge is collected against, or the failure that stopped it. */
  private async createOrder(recoveryCase: RecoveryCase, receipt: string): Promise<string | ProviderResult> {
    const order = await this.call('POST', '/v1/orders', {
      amount: recoveryCase.context.amount,
      currency: recoveryCase.context.currency,
      receipt,
      notes: { caseId: recoveryCase.id, subscriptionId: recoveryCase.context.subscriptionId },
    });
    if (!order.ok) return { status: 'failed', message: `Razorpay order creation returned HTTP ${order.status}: ${this.describe(order)}` };
    return typeof order.payload.id === 'string' ? order.payload.id : { status: 'failed', message: 'Razorpay returned an order without an id' };
  }

  private async findOrderByReceipt(receipt: string): Promise<string | undefined> {
    const response = await this.call('GET', '/v1/orders', undefined, { receipt });
    return response.ok ? this.firstId(response.payload.items) : undefined;
  }

  /**
   * The live charge already collected against this order, if there is one. Razorpay lists failed and
   * created payments here too, and neither is a charge: replaying one would strand the action on a
   * result whose webhook has already fired, so only a payment that took the money counts.
   */
  private async findPaymentOfOrder(orderId: string): Promise<string | undefined> {
    const response = await this.call('GET', `/v1/orders/${encodeURIComponent(orderId)}/payments`);
    if (!response.ok || !Array.isArray(response.payload.items)) return undefined;
    const live = response.payload.items.find((item): item is { id: string; status: string } => {
      if (typeof item !== 'object' || item === null) return false;
      const candidate = item as { id?: unknown; status?: unknown };
      return typeof candidate.id === 'string' && typeof candidate.status === 'string' && LIVE_PAYMENT_STATUSES.includes(candidate.status);
    });
    return live?.id;
  }

  private async findLinkByReference(reference: string): Promise<string | undefined> {
    const response = await this.call('GET', '/v1/payment_links', undefined, { reference_id: reference });
    return response.ok ? this.firstId(response.payload.payment_links) : undefined;
  }

  /** The mandate identity Razorpay needs to charge again, or undefined when the payment carries none. */
  private mandateOf(payment: Record<string, unknown>): MandateIdentity | undefined {
    const tokenId = typeof payment.token_id === 'string' ? payment.token_id : undefined;
    const customerId = typeof payment.customer_id === 'string' ? payment.customer_id : undefined;
    const email = typeof payment.email === 'string' ? payment.email : undefined;
    const contact = typeof payment.contact === 'string' ? payment.contact : undefined;
    if (payment.recurring !== true || !tokenId || !customerId || !email || !contact) return undefined;
    return { tokenId, customerId, email, contact };
  }

  /** Folds an action identity into the length Razorpay accepts while staying deterministic. */
  private reference(idempotencyKey: string): string {
    if (idempotencyKey.length <= REFERENCE_MAX_LENGTH) return idempotencyKey;
    const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 8);
    return `${idempotencyKey.slice(0, REFERENCE_MAX_LENGTH - digest.length - 1)}_${digest}`;
  }

  /** Why no money operation may run, or undefined when the adapter is safely configured. */
  private refusal(): string | undefined {
    if (!this.options.keyId || !this.options.keySecret) return 'Razorpay credentials are not configured';
    // The MVP never moves real money, so live credentials are refused rather than trusted.
    return this.options.keyId.startsWith('rzp_test_') ? undefined : 'Razorpay credentials are not Test Mode keys, so no money operation was attempted';
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, query?: Record<string, string>): Promise<RazorpayResponse> {
    const url = new URL(`${this.options.baseUrl ?? 'https://api.razorpay.com'}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const fetcher = this.options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Basic ${Buffer.from(`${this.options.keyId}:${this.options.keySecret}`).toString('base64')}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      return { ok: false, status: 0, payload: {}, transportError: error instanceof Error ? error.message : String(error) };
    }
    return { ok: response.ok, status: response.status, payload: await this.readJson(response) };
  }

  private firstId(items: unknown): string | undefined {
    if (!Array.isArray(items)) return undefined;
    const match = items.find((item): item is { id: string } => typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string');
    return match?.id;
  }

  private webhookSecret(): string {
    return this.options.webhookSecret ?? this.options.keySecret;
  }

  private now(): Date {
    return (this.options.clock ?? new SystemClock()).now();
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = await response.json();
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  /** The provider's own words for a failure, so an operator sees why rather than a status code alone. */
  private describe(response: RazorpayResponse): string {
    if (response.transportError !== undefined) return `request failed: ${response.transportError}`;
    const error = typeof response.payload.error === 'object' && response.payload.error !== null ? response.payload.error as Record<string, unknown> : {};
    return typeof error.description === 'string' ? error.description : 'no error description';
  }
}
