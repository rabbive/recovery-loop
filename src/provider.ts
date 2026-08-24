import { createHmac, timingSafeEqual } from 'node:crypto';
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
    const attempt = recoveryCase.attempts[0];
    if (attempt?.method !== 'recurring_mandate') return { eligible: false, reason: 'No authorized recurring mandate is available' };
    if (attempt.status !== 'failed') return { eligible: false, reason: 'The original attempt is not failed' };
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
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly clock?: Clock;
}

export class RazorpayTestModeProvider implements PaymentProvider {
  constructor(private readonly options: RazorpayTestModeOptions) {}

  /** The webhook signature Razorpay would send for this body. Exposed for contract tests. */
  signPayload(raw: string): string {
    return createHmac('sha256', this.options.keySecret).update(raw).digest('hex');
  }

  verifyEvent(raw: string, signature: string): boolean {
    if (!raw || !signature || !this.options.keySecret) return false;
    const expected = createHmac('sha256', this.options.keySecret).update(raw).digest('hex');
    const supplied = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
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
    const attempt = recoveryCase.attempts[0];
    return attempt?.method === 'recurring_mandate'
      ? { eligible: true, reason: 'Recurring mandate supplied by provider' }
      : { eligible: false, reason: 'Only provider-supported recurring mandates may be retried' };
  }

  async submitRetry(recoveryCase: RecoveryCase, _action: RecoveryAction): Promise<ProviderResult> {
    if (!this.credentialed()) return { status: 'failed', message: 'Razorpay credentials are not configured' };
    const eligibility = await this.retryEligibility(recoveryCase);
    // Razorpay's public API cannot recharge an arbitrary card payment; say so instead of pretending.
    if (!eligibility.eligible) return { status: 'failed', message: `Retry is not supported for this payment: ${eligibility.reason}` };
    return { status: 'submitted', message: 'Razorpay Test Mode retry is delegated to the existing recurring mandate' };
  }

  async createFallbackLink(recoveryCase: RecoveryCase, action: RecoveryAction): Promise<FallbackLinkResult> {
    const expiresAtSeconds = Math.floor(this.now().getTime() / 1000) + FALLBACK_LINK_TTL_SECONDS;
    const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();
    if (!this.credentialed()) return { status: 'failed', message: 'Razorpay credentials are not configured', expiresAt };
    const fetcher = this.options.fetcher ?? fetch;
    // reference_id must be unique per link, so the action identity carries the idempotency:
    // a duplicate is rejected by Razorpay rather than creating a second link.
    const body = {
      amount: recoveryCase.context.amount,
      currency: recoveryCase.context.currency,
      reference_id: action.idempotencyKey,
      expire_by: expiresAtSeconds,
      description: `Renewal recovery for order ${recoveryCase.context.orderId}`,
      notes: { caseId: recoveryCase.id, subscriptionId: recoveryCase.context.subscriptionId },
    };
    let response: Response;
    try {
      response = await fetcher(`${this.options.baseUrl ?? 'https://api.razorpay.com'}/v1/payment_links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${this.options.keyId}:${this.options.keySecret}`).toString('base64')}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { status: 'failed', message: `Razorpay payment-link request failed: ${error instanceof Error ? error.message : String(error)}`, expiresAt };
    }
    const payload = await this.readJson(response);
    if (response.ok) {
      // A created link without an id means the response is not what the API documents.
      if (typeof payload.id !== 'string') return { status: 'failed', message: 'Razorpay returned a payment link without an id', expiresAt };
      return { status: 'submitted', providerReference: payload.id, message: 'Razorpay Test Mode payment link created', expiresAt };
    }
    const description = this.errorDescription(payload);
    if (response.status === 400 && /already exists/i.test(description)) {
      // The link already exists, so look up its real id rather than synthesizing one.
      const existing = await this.findLinkByReference(action.idempotencyKey, fetcher);
      return existing === undefined
        ? { status: 'submitted', message: 'Razorpay already holds a payment link for this action identity, but its id could not be resolved', expiresAt, idempotent: true }
        : { status: 'submitted', providerReference: existing, message: 'Razorpay already holds a payment link for this action identity', expiresAt, idempotent: true };
    }
    return { status: 'failed', message: `Razorpay payment-link request returned HTTP ${response.status}: ${description}`, expiresAt };
  }

  private async findLinkByReference(reference: string, fetcher: typeof fetch): Promise<string | undefined> {
    try {
      const url = new URL(`${this.options.baseUrl ?? 'https://api.razorpay.com'}/v1/payment_links`);
      url.searchParams.set('reference_id', reference);
      const response = await fetcher(url.toString(), {
        method: 'GET',
        headers: { authorization: `Basic ${Buffer.from(`${this.options.keyId}:${this.options.keySecret}`).toString('base64')}` },
      });
      if (!response.ok) return undefined;
      const payload = await this.readJson(response);
      const links = Array.isArray(payload.payment_links) ? payload.payment_links : [];
      const match = links.find((link): link is { id: string } => typeof link === 'object' && link !== null && typeof (link as { id?: unknown }).id === 'string');
      return match?.id;
    } catch {
      return undefined;
    }
  }

  private credentialed(): boolean {
    return Boolean(this.options.keyId && this.options.keySecret);
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

  private errorDescription(payload: Record<string, unknown>): string {
    const error = typeof payload.error === 'object' && payload.error !== null ? payload.error as Record<string, unknown> : {};
    return typeof error.description === 'string' ? error.description : 'no error description';
  }
}
