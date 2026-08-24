import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRecoveryApplication } from '../src/application.js';
import { FixedClock } from '../src/provider.js';
import { AnthropicDiagnosisEngine, FixtureDiagnosisEngine } from '../src/diagnosis.js';

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

  it('rejects invalid ports and incomplete provider credentials', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '3000', RAZORPAY_KEY_ID: 'key' })).toThrow(/configured together/);
  });
});
