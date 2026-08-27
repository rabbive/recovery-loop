import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRecoveryApplication } from '../src/application.js';
import { FixedClock } from '../src/provider.js';
import { AnthropicDiagnosisEngine, FixtureDiagnosisEngine, ModelDiagnosisEngine } from '../src/diagnosis.js';
import { addAttempt, createRecoveryCase } from '../src/domain.js';

const context = {
  customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z',
};

describe('application scaffold', () => {
  it('loads validated runtime configuration without exposing secrets in the result shape', () => {
    const config = loadConfig({ PORT: '3100', DATABASE_URL: 'postgres://localhost/recovery_loop', RAZORPAY_KEY_ID: 'key', RAZORPAY_KEY_SECRET: 'secret' });
    expect(config.port).toBe(3100);
    expect(config.databaseUrl).toContain('recovery_loop');
    expect(config.razorpayKeySecret).toBe('secret');
  });

  it('composes a workflow seam that tests can drive with a fixed clock', async () => {
    const application = createRecoveryApplication({ config: loadConfig({ PORT: '3000' }), clock: new FixedClock('2026-01-01T00:00:00.000Z') });
    const recoveryCase = await application.workflow.openCase('scaffold-case', context);
    expect(recoveryCase.status).toBe('at_risk');
    expect(recoveryCase.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(await application.store.get('scaffold-case')).toEqual(recoveryCase);
  });

  it('defaults to a clock that moves, so link expiry and audit timestamps are real', () => {
    // A frozen clock in the running app would stop every fallback link from ever lapsing and
    // stamp every audit event with the same instant. Only tests and the seeded batch pin time.
    const before = Date.now();
    const { clock } = createRecoveryApplication({ config: loadConfig({ PORT: '3100' }) });

    const now = clock.now().getTime();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('uses the fixture diagnosis engine when no model credential is configured', () => {
    const application = createRecoveryApplication({ config: loadConfig({ PORT: '3000' }) });
    expect(application.diagnosisEngine).toBeInstanceOf(FixtureDiagnosisEngine);
  });

  it('uses the Anthropic diagnosis engine when a model credential is configured', () => {
    const config = loadConfig({ PORT: '3000', ANTHROPIC_API_KEY: 'model-key', ANTHROPIC_MODEL: 'claude-opus-5' });
    expect(config.anthropicApiKey).toBe('model-key');
    expect(config.anthropicModel).toBe('claude-opus-5');
    expect(createRecoveryApplication({ config }).diagnosisEngine).toBeInstanceOf(AnthropicDiagnosisEngine);
  });

  it('uses Pincc ahead of Anthropic when Pincc credentials are configured', () => {
    const config = loadConfig({
      PORT: '3000',
      PINCC_API_KEY: 'pincc-key',
      PINCC_MODEL: 'tool-capable-model',
      PINCC_BASE_URL: 'https://v2.pincc.ai/',
      ANTHROPIC_API_KEY: 'anthropic-key',
    });

    expect(config.pinccApiKey).toBe('pincc-key');
    expect(config.pinccModel).toBe('tool-capable-model');
    expect(config.pinccBaseUrl).toBe('https://v2.pincc.ai');
    expect(createRecoveryApplication({ config }).diagnosisEngine).toBeInstanceOf(ModelDiagnosisEngine);
    expect(createRecoveryApplication({ config }).diagnosisEngine).not.toBeInstanceOf(AnthropicDiagnosisEngine);
  });

  it('uses Pincc\'s native Messages route for Claude model ids', async () => {
    const config = loadConfig({
      PORT: '3000',
      PINCC_API_KEY: 'pincc-key',
      PINCC_MODEL: 'claude-sonnet-5',
      PINCC_BASE_URL: 'https://v2.pincc.ai',
    });
    const recoveryCase = addAttempt(createRecoveryCase('pincc-claude', context, '2026-01-01T00:00:00.000Z'), {
      id: 'pincc-attempt-1',
      providerPaymentId: 'pay_pincc',
      method: 'recurring_mandate',
      status: 'failed',
      failureCode: 'insufficient_funds',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      content: [{
        type: 'tool_use',
        name: 'record_diagnosis',
        input: {
          failureCategory: 'transient',
          confidence: 0.9,
          evidence: ['pincc-attempt-1'],
          recommendedAction: 'retry',
          explanation: 'Insufficient funds is transient.',
        },
      }],
    }), { status: 200 }));

    const diagnosis = await createRecoveryApplication({ config }).diagnosisEngine.diagnose(recoveryCase);

    expect(diagnosis.modelVersion).toBe('claude-sonnet-5');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://v2.pincc.ai/v1/messages');
    fetchSpy.mockRestore();
  });

  it('wires the Razorpay adapter with its webhook secret and the injected clock', async () => {
    const config = loadConfig({ PORT: '3000', RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'test_secret', RAZORPAY_WEBHOOK_SECRET: 'hook_secret' });
    const application = createRecoveryApplication({ config, clock: new FixedClock('2026-01-01T00:00:00.000Z') });
    const signed = createHmac('sha256', 'hook_secret').update('{"a":1}').digest('hex');
    expect(application.provider.verifyEvent('{"a":1}', signed)).toBe(true);
    // The adapter must never reach the network from a test, so the global fetch is stubbed here.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'plink_wired' }), { status: 200 }));
    const link = await application.provider.createFallbackLink(
      addAttempt(createRecoveryCase('wired-case', context, '2026-01-01T00:00:00.000Z'), { id: 'a1', providerPaymentId: 'pay_1', method: 'recurring_mandate', status: 'failed', occurredAt: '2026-01-01T00:00:00.000Z' }),
      { id: 'wired-case:action:1', kind: 'fallback_link', status: 'pending', idempotencyKey: 'wired-case:fallback_link', createdAt: '2026-01-01T00:00:00.000Z' },
    );
    expect(link.expiresAt).toBe('2026-01-02T00:00:00.000Z');
    expect(link.providerReference).toBe('plink_wired');
    fetchSpy.mockRestore();
  });

  it('rejects invalid ports and incomplete provider credentials', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '3000', RAZORPAY_KEY_ID: 'key' })).toThrow(/configured together/);
    expect(() => loadConfig({ PORT: '3000', PINCC_API_KEY: 'pincc-key' })).toThrow(/PINCC_MODEL/);
    expect(() => loadConfig({ PORT: '3000', PINCC_API_KEY: 'pincc-key', PINCC_MODEL: 'model', PINCC_BASE_URL: 'http://v2.pincc.ai' })).toThrow(/HTTPS/);
  });
});
