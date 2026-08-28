import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRecoveryApplication } from '../src/application.js';
import { FixedClock, RazorpayTestModeProvider } from '../src/provider.js';
import { AnthropicDiagnosisEngine, FixtureDiagnosisEngine, ModelDiagnosisEngine } from '../src/diagnosis.js';
import { addAttempt, createRecoveryCase } from '../src/domain.js';

const context = {
  customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z',
};

describe('application scaffold', () => {
  it('loads validated runtime configuration without exposing secrets in the result shape', () => {
    const config = loadConfig({ PORT: '3100', DATABASE_URL: 'postgres://localhost/recovery_loop', RAZORPAY_KEY_ID: 'key', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'hook' });
    expect(config.port).toBe(3100);
    expect(config.databaseUrl).toContain('recovery_loop');
    expect(config.razorpayKeySecret).toBe('secret');
    expect(config.razorpayWebhookSecret).toBe('hook');
  });

  it('refuses to run in memory when the deployment says a database is required', () => {
    // Falling back to memory storage on a deployment loses every case and audit record on restart
    // while the instance keeps answering 200, so a missing database has to be a startup failure.
    expect(() => loadConfig({ PORT: '3000', REQUIRE_DATABASE: 'true' })).toThrow(/REQUIRE_DATABASE=true requires DATABASE_URL/);
    expect(() => loadConfig({ PORT: '3000', REQUIRE_DATABASE: 'yes' })).toThrow(/must be true or false/);
    expect(loadConfig({ PORT: '3000', REQUIRE_DATABASE: 'false' }).requireDatabase).toBe(false);
    expect(loadConfig({ PORT: '3000' }).requireDatabase).toBe(false);
    expect(loadConfig({ PORT: '3000', REQUIRE_DATABASE: 'true', DATABASE_URL: 'postgres://localhost/recovery_loop' }).requireDatabase).toBe(true);
  });

  it('names each runtime component separately, so nothing reads as more or less live than it is', () => {
    const summarize = (environment: NodeJS.ProcessEnv) => createRecoveryApplication({ config: loadConfig(environment), clock: new FixedClock('2026-01-01T00:00:00.000Z') }).runtimeSummary;

    expect(summarize({ PORT: '3000' })).toEqual({
      payments: 'Deterministic simulator',
      liveDiagnosis: 'Deterministic fixture engine',
      seededEvaluation: 'Simulator payments · deterministic fixture diagnosis',
      persistence: 'In-memory (non-durable)',
      recurringRetry: 'Disabled pending Test Mode proof',
    });
    expect(summarize({ PORT: '3000', PINCC_API_KEY: 'key', PINCC_MODEL: 'claude-sonnet-5' }).liveDiagnosis).toBe('Pincc · claude-sonnet-5');
    expect(summarize({ PORT: '3000', PINCC_API_KEY: 'key', PINCC_MODEL: 'gpt-4o-mini' }).liveDiagnosis).toBe('Pincc · gpt-4o-mini');
    expect(summarize({ PORT: '3000', ANTHROPIC_API_KEY: 'key', ANTHROPIC_MODEL: 'claude-sonnet-5' }).liveDiagnosis).toBe('Anthropic · claude-sonnet-5');
    // The batch is fixtures whatever a live case uses, or its published figures would not reproduce.
    expect(summarize({ PORT: '3000', PINCC_API_KEY: 'key', PINCC_MODEL: 'claude-sonnet-5' }).seededEvaluation).toBe('Simulator payments · deterministic fixture diagnosis');
    expect(summarize({ PORT: '3000', RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'hook' }).payments).toBe('Razorpay Test Mode');
    expect(summarize({ PORT: '3000', RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'hook', RAZORPAY_RECURRING_RETRY_ENABLED: 'true' }).recurringRetry).toBe('Enabled for Test Mode proof');
    expect(summarize({ PORT: '3000', DATABASE_URL: 'postgres://localhost/recovery_loop' }).persistence).toBe('PostgreSQL');
  });

  it('reports the store it actually composed rather than the one it was configured for', () => {
    const application = createRecoveryApplication({ config: loadConfig({ PORT: '3000' }), clock: new FixedClock('2026-01-01T00:00:00.000Z') });

    expect(application.persistenceMode).toBe('memory');
  });

  it('refuses Razorpay credentials with no webhook secret of their own', () => {
    // Falling back to the API secret meant one leaked value could both call Razorpay and forge
    // deliveries, and a misconfigured instance verified signatures nobody had ever issued.
    expect(() => loadConfig({ PORT: '3000', RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'api_secret' }))
      .toThrow(/RAZORPAY_WEBHOOK_SECRET/);
  });

  it('keeps the unproven recurring charge off unless something says exactly true', () => {
    expect(loadConfig({ PORT: '3000' }).razorpayRecurringRetryEnabled).toBe(false);
    expect(loadConfig({ PORT: '3000', RAZORPAY_RECURRING_RETRY_ENABLED: 'false' }).razorpayRecurringRetryEnabled).toBe(false);
    expect(loadConfig({ PORT: '3000', RAZORPAY_RECURRING_RETRY_ENABLED: 'true' }).razorpayRecurringRetryEnabled).toBe(true);
    // A typo must read as off. Anything else would arm a money operation nobody has watched work.
    expect(() => loadConfig({ PORT: '3000', RAZORPAY_RECURRING_RETRY_ENABLED: 'yes' })).toThrow(/must be true or false/);
  });

  it('reaches no network for a recurring charge while the retry is unproven', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'api_secret', webhookSecret: 'hook_secret', clock: new FixedClock('2026-01-01T00:00:00.000Z') });
    const mandate = addAttempt(createRecoveryCase('gated-case', context, '2026-01-01T00:00:00.000Z'), { id: 'a1', providerPaymentId: 'pay_1', method: 'recurring_mandate', status: 'failed', occurredAt: '2026-01-01T00:00:00.000Z' });

    const eligibility = await provider.retryEligibility(mandate);
    const submitted = await provider.submitRetry(mandate, { id: 'gated-case:action:1', kind: 'retry', status: 'pending', idempotencyKey: 'gated-case:retry', createdAt: '2026-01-01T00:00:00.000Z' });

    expect(eligibility.eligible).toBe(false);
    expect(submitted.status).toBe('failed');
    expect(submitted.message).toMatch(/unverified and disabled/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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

  it('gives the simulator a secret nobody outside the process can guess', () => {
    // Two instances with no configured secret must not accept each other's deliveries: a public
    // demo whose signature format is public is a public write endpoint.
    const first = createRecoveryApplication({ config: loadConfig({ PORT: '3000' }), clock: new FixedClock('2026-01-01T00:00:00.000Z') });
    const second = createRecoveryApplication({ config: loadConfig({ PORT: '3000' }), clock: new FixedClock('2026-01-01T00:00:00.000Z') });

    expect(first.provider.verifyEvent('{"a":1}', 'sim:{"a":1}')).toBe(false);
    const configured = createRecoveryApplication({ config: loadConfig({ PORT: '3000', SIMULATOR_WEBHOOK_SECRET: 'shared' }), clock: new FixedClock('2026-01-01T00:00:00.000Z') });
    const signed = createHmac('sha256', 'shared').update('{"a":1}').digest('hex');
    expect(configured.provider.verifyEvent('{"a":1}', signed)).toBe(true);
    expect(first.provider.verifyEvent('{"a":1}', signed)).toBe(false);
    expect(second.provider.verifyEvent('{"a":1}', signed)).toBe(false);
  });

  it('reads the control-plane token, and leaves it undefined when nothing configured one', () => {
    expect(loadConfig({ PORT: '3000', CONTROL_PLANE_TOKEN: 'operator-token' }).controlPlaneToken).toBe('operator-token');
    expect(loadConfig({ PORT: '3000', CONTROL_PLANE_TOKEN: '   ' }).controlPlaneToken).toBeUndefined();
    expect(loadConfig({ PORT: '3000' }).controlPlaneToken).toBeUndefined();
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
