import { describe, expect, it } from 'vitest';
import { AnthropicDiagnosisEngine, AnthropicMessagesModel, DiagnosisUnavailableError, buildDiagnosisRequest, parseDiagnosis, type DiagnosisModel } from '../src/diagnosis.js';
import { addAttempt, addProviderEvent, createRecoveryCase } from '../src/domain.js';

function caseWithFailure() {
  const base = createRecoveryCase('case-1', {
    customerId: 'customer-1',
    subscriptionId: 'subscription-1',
    orderId: 'order-1',
    amount: 4999,
    currency: 'INR',
    dueAt: '2026-01-01T00:00:00.000Z',
  }, '2026-01-01T00:00:00.000Z');
  const withEvent = addProviderEvent(base, {
    id: 'event-1',
    type: 'payment_failed',
    caseId: 'case-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    receivedAt: '2026-01-01T00:00:01.000Z',
    payload: { method: 'recurring_mandate', failureCode: 'insufficient_funds', card_number: '4111111111111111' },
  });
  return addAttempt(withEvent, {
    id: 'case-1:attempt:1',
    providerPaymentId: 'pay_1',
    method: 'recurring_mandate',
    status: 'failed',
    failureCode: 'insufficient_funds',
    occurredAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('parseDiagnosis', () => {
  it('accepts well-formed structured model output and records the model version', () => {
    const diagnosis = parseDiagnosis({
      failureCategory: 'transient',
      confidence: 0.91,
      evidence: ['event-1'],
      recommendedAction: 'retry',
      explanation: 'Insufficient funds on an authorized mandate is usually transient.',
    }, 'claude-sonnet-5');
    expect(diagnosis.failureCategory).toBe('transient');
    expect(diagnosis.confidence).toBe(0.91);
    expect(diagnosis.recommendedAction).toBe('retry');
    expect(diagnosis.modelVersion).toBe('claude-sonnet-5');
  });

  it('rejects output with an unknown failure category', () => {
    expect(() => parseDiagnosis({
      failureCategory: 'vibes',
      confidence: 0.9,
      evidence: ['event-1'],
      recommendedAction: 'retry',
      explanation: 'x',
    }, 'claude-sonnet-5')).toThrow(DiagnosisUnavailableError);
  });

  it('rejects output with a confidence outside 0..1', () => {
    expect(() => parseDiagnosis({
      failureCategory: 'transient',
      confidence: 7,
      evidence: ['event-1'],
      recommendedAction: 'retry',
      explanation: 'x',
    }, 'claude-sonnet-5')).toThrow(DiagnosisUnavailableError);
  });

  it('rejects output that cites no evidence', () => {
    expect(() => parseDiagnosis({
      failureCategory: 'transient',
      confidence: 0.9,
      evidence: [],
      recommendedAction: 'retry',
      explanation: 'x',
    }, 'claude-sonnet-5')).toThrow(DiagnosisUnavailableError);
  });
});

describe('buildDiagnosisRequest', () => {
  it('sends case signals without raw payment credentials', () => {
    const serialized = JSON.stringify(buildDiagnosisRequest(caseWithFailure()));
    expect(serialized).toContain('insufficient_funds');
    expect(serialized).toContain('event-1');
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('card_number');
  });
});

describe('AnthropicDiagnosisEngine', () => {
  it('returns the structured diagnosis produced by the model', async () => {
    const model: DiagnosisModel = {
      version: 'claude-sonnet-5',
      async infer() {
        return {
          failureCategory: 'transient',
          confidence: 0.88,
          evidence: ['event-1'],
          recommendedAction: 'retry',
          explanation: 'Recoverable decline on an authorized mandate.',
        };
      },
    };
    const diagnosis = await new AnthropicDiagnosisEngine(model).diagnose(caseWithFailure());
    expect(diagnosis.recommendedAction).toBe('retry');
    expect(diagnosis.modelVersion).toBe('claude-sonnet-5');
  });

  it('fails safe when the model output is malformed', async () => {
    const model: DiagnosisModel = {
      version: 'claude-sonnet-5',
      async infer() { return { nonsense: true }; },
    };
    await expect(new AnthropicDiagnosisEngine(model).diagnose(caseWithFailure())).rejects.toBeInstanceOf(DiagnosisUnavailableError);
  });

  it('fails safe when the model call throws', async () => {
    const model: DiagnosisModel = {
      version: 'claude-sonnet-5',
      async infer() { throw new Error('model timeout'); },
    };
    await expect(new AnthropicDiagnosisEngine(model).diagnose(caseWithFailure())).rejects.toBeInstanceOf(DiagnosisUnavailableError);
  });
});

describe('AnthropicMessagesModel', () => {
  function model(handler: (url: string, init: RequestInit) => Response | Promise<Response>, options: Record<string, unknown> = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImplementation = (async (url: string | URL | Request, init?: RequestInit) => {
      const record = { url: String(url), init: init ?? {} };
      calls.push(record);
      return handler(record.url, record.init);
    }) as unknown as typeof fetch;
    return { calls, instance: new AnthropicMessagesModel({ apiKey: 'test-key', fetchImplementation, ...options }) };
  }

  const validOutput = { failureCategory: 'transient', confidence: 0.8, evidence: ['event-1'], recommendedAction: 'retry', explanation: 'ok' };

  function toolUseResponse(input: unknown): Response {
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'thinking' }, { type: 'tool_use', name: 'record_diagnosis', input }] }), { status: 200 });
  }

  it('forces the record_diagnosis tool and returns its input', async () => {
    const { calls, instance } = model(() => toolUseResponse(validOutput));
    const result = await instance.infer(buildDiagnosisRequest(caseWithFailure()));
    expect(result).toMatchObject({ failureCategory: 'transient', recommendedAction: 'retry' });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_diagnosis' });
    expect(body.model).toBe('claude-sonnet-5');
    expect(String(calls[0]?.init.body)).not.toContain('4111111111111111');
  });

  it('sends authentication and version headers', async () => {
    const { calls, instance } = model(() => toolUseResponse(validOutput));
    await instance.infer(buildDiagnosisRequest(caseWithFailure()));
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('marks a rate-limited response retryable', async () => {
    const { instance } = model(() => new Response('rate limited', { status: 429 }));
    await expect(instance.infer(buildDiagnosisRequest(caseWithFailure()))).rejects.toMatchObject({ name: 'DiagnosisUnavailableError', retryable: true });
  });

  it('surfaces the retry-after delay advertised by a rate-limited response', async () => {
    const { instance } = model(() => new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }));
    await expect(instance.infer(buildDiagnosisRequest(caseWithFailure()))).rejects.toMatchObject({ retryable: true, retryAfterMilliseconds: 2000 });
  });

  it('marks a rejected request terminal', async () => {
    const { instance } = model(() => new Response('bad request', { status: 400 }));
    await expect(instance.infer(buildDiagnosisRequest(caseWithFailure()))).rejects.toMatchObject({ name: 'DiagnosisUnavailableError', retryable: false });
  });

  it('fails safe when no tool call is returned', async () => {
    const { instance } = model(() => new Response(JSON.stringify({ content: [{ type: 'text', text: 'I refuse' }] }), { status: 200 }));
    await expect(instance.infer(buildDiagnosisRequest(caseWithFailure()))).rejects.toBeInstanceOf(DiagnosisUnavailableError);
  });

  it('aborts a slow model call and reports it as retryable', async () => {
    const { instance } = model((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }), { timeoutMilliseconds: 10 });
    await expect(instance.infer(buildDiagnosisRequest(caseWithFailure()))).rejects.toMatchObject({ name: 'DiagnosisUnavailableError', retryable: true });
  });
});

describe('DiagnosisUnavailableError classification', () => {
  it('treats malformed model output as terminal', async () => {
    const model: DiagnosisModel = { version: 'claude-sonnet-5', async infer() { return { nonsense: true }; } };
    await expect(new AnthropicDiagnosisEngine(model).diagnose(caseWithFailure())).rejects.toMatchObject({ retryable: false });
  });

  it('preserves the retryable flag raised by the model transport', async () => {
    const model: DiagnosisModel = { version: 'claude-sonnet-5', async infer() { throw new DiagnosisUnavailableError('model returned HTTP 503', { retryable: true }); } };
    await expect(new AnthropicDiagnosisEngine(model).diagnose(caseWithFailure())).rejects.toMatchObject({ retryable: true });
  });

  it('treats an unclassified transport error as retryable', async () => {
    const model: DiagnosisModel = { version: 'claude-sonnet-5', async infer() { throw new Error('socket hang up'); } };
    await expect(new AnthropicDiagnosisEngine(model).diagnose(caseWithFailure())).rejects.toMatchObject({ retryable: true });
  });
});
