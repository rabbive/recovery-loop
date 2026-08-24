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
}

export interface PaymentProvider {
  verifyEvent(raw: string, signature: string): boolean;
  normalizeEvent(input: NormalizedEventInput, receivedAt: string): ProviderEvent;
  retryEligibility(recoveryCase: RecoveryCase): RetryEligibility;
  submitRetry(recoveryCase: RecoveryCase, action: RecoveryAction): ProviderResult;
  createFallbackLink(recoveryCase: RecoveryCase, action: RecoveryAction): ProviderResult & { readonly expiresAt: string };
}

export interface SimulatorScenario {
  readonly retry: 'success' | 'failure' | 'unsupported';
  readonly fallback: 'success' | 'failure';
  readonly diagnosis: 'transient' | 'hard_decline' | 'low_confidence' | 'malformed';
}

export class DeterministicSimulator implements PaymentProvider {
  private readonly scenarios: ReadonlyMap<string, SimulatorScenario>;
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

  retryEligibility(recoveryCase: RecoveryCase): RetryEligibility {
    const attempt = recoveryCase.attempts[0];
    if (attempt?.method !== 'recurring_mandate') return { eligible: false, reason: 'No authorized recurring mandate is available' };
    if (attempt.status !== 'failed') return { eligible: false, reason: 'The original attempt is not failed' };
    const scenario = this.scenarios.get(recoveryCase.id);
    if (scenario?.retry === 'unsupported') return { eligible: false, reason: 'The provider does not support retry for this mandate' };
    return { eligible: true, reason: 'Authorized recurring mandate is eligible' };
  }

  submitRetry(recoveryCase: RecoveryCase, action: RecoveryAction): ProviderResult {
    this.calls.push(action);
    const scenario = this.scenarios.get(recoveryCase.id);
    if (scenario?.retry === 'failure') return { status: 'failed', message: 'Simulated retry failure' };
    return { status: 'succeeded', providerReference: `sim_retry_${recoveryCase.id}`, message: 'Simulated retry succeeded' };
  }

  createFallbackLink(recoveryCase: RecoveryCase, action: RecoveryAction): ProviderResult & { readonly expiresAt: string } {
    this.calls.push(action);
    const scenario = this.scenarios.get(recoveryCase.id);
    const expiresAt = new Date(this.clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString();
    if (scenario?.fallback === 'failure') return { status: 'failed', message: 'Simulated fallback-link failure', expiresAt };
    return { status: 'succeeded', providerReference: `sim_link_${recoveryCase.id}`, message: 'Simulated fallback link created', expiresAt };
  }
}

export class RazorpayTestModeProvider implements PaymentProvider {
  constructor(
    private readonly options: {
      readonly keyId: string;
      readonly keySecret: string;
      readonly baseUrl?: string;
      readonly fetcher?: typeof fetch;
    },
  ) {}

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

  retryEligibility(recoveryCase: RecoveryCase): RetryEligibility {
    const attempt = recoveryCase.attempts[0];
    return attempt?.method === 'recurring_mandate'
      ? { eligible: true, reason: 'Recurring mandate supplied by provider' }
      : { eligible: false, reason: 'Only provider-supported recurring mandates may be retried' };
  }

  submitRetry(_recoveryCase: RecoveryCase, _action: RecoveryAction): ProviderResult {
    if (!this.options.keyId || !this.options.keySecret) return { status: 'failed', message: 'Razorpay credentials are not configured' };
    return { status: 'submitted', message: 'Razorpay Test Mode retry requires a configured mandate operation' };
  }

  createFallbackLink(_recoveryCase: RecoveryCase, _action: RecoveryAction): ProviderResult & { readonly expiresAt: string } {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    if (!this.options.keyId || !this.options.keySecret) return { status: 'failed', message: 'Razorpay credentials are not configured', expiresAt };
    return { status: 'submitted', message: 'Razorpay Test Mode payment-link operation is ready for configuration', expiresAt };
  }
}
