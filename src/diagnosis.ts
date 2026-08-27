import type { Diagnosis, FailureCategory, RecommendedAction, RecoveryCase } from './domain.js';

/**
 * Raised whenever a usable diagnosis cannot be produced. Callers must fail safe: no money action.
 * `retryable` distinguishes an infrastructure outage (the case can be diagnosed again) from
 * output the model is not going to fix on its own (the case needs a human).
 */
export class DiagnosisUnavailableError extends Error {
  readonly retryable: boolean;
  /** Delay advertised by the provider, when it told us how long to wait. */
  readonly retryAfterMilliseconds?: number;

  constructor(reason: string, options: { readonly retryable?: boolean; readonly retryAfterMilliseconds?: number } = {}) {
    super(`Diagnosis unavailable: ${reason}`);
    this.name = 'DiagnosisUnavailableError';
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMilliseconds !== undefined) this.retryAfterMilliseconds = options.retryAfterMilliseconds;
  }
}

export interface DiagnosisEngine {
  diagnose(recoveryCase: RecoveryCase): Promise<Diagnosis>;
}

export class FixtureDiagnosisEngine implements DiagnosisEngine {
  constructor(private readonly diagnosisByCase = new Map<string, Diagnosis>()) {}

  async diagnose(recoveryCase: RecoveryCase): Promise<Diagnosis> {
    return this.diagnosisByCase.get(recoveryCase.id) ?? {
      failureCategory: 'transient',
      confidence: 0.95,
      evidence: recoveryCase.events.map((event) => event.id),
      recommendedAction: 'retry',
      explanation: 'The failed renewal has an authorized recurring mandate and no terminal signal.',
      modelVersion: 'fixture-v1',
    };
  }
}

const FAILURE_CATEGORIES: readonly FailureCategory[] = ['transient', 'hard_decline', 'expired', 'cancelled', 'dispute', 'unsupported', 'unknown'];
const RECOMMENDED_ACTIONS: readonly RecommendedAction[] = ['retry', 'fallback_link', 'stop', 'escalate'];

export function parseDiagnosis(value: unknown, modelVersion: string): Diagnosis {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DiagnosisUnavailableError('model output is not an object');
  const output = value as Record<string, unknown>;
  const failureCategory = output.failureCategory;
  if (typeof failureCategory !== 'string' || !FAILURE_CATEGORIES.includes(failureCategory as FailureCategory)) {
    throw new DiagnosisUnavailableError(`unsupported failure category ${JSON.stringify(failureCategory)}`);
  }
  const recommendedAction = output.recommendedAction;
  if (typeof recommendedAction !== 'string' || !RECOMMENDED_ACTIONS.includes(recommendedAction as RecommendedAction)) {
    throw new DiagnosisUnavailableError(`unsupported recommended action ${JSON.stringify(recommendedAction)}`);
  }
  const confidence = output.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new DiagnosisUnavailableError('confidence must be a number between 0 and 1');
  }
  const evidence = output.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0 || !evidence.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)) {
    throw new DiagnosisUnavailableError('evidence must cite at least one case signal');
  }
  const explanation = output.explanation;
  if (typeof explanation !== 'string' || explanation.trim().length === 0) throw new DiagnosisUnavailableError('explanation is missing');
  return {
    failureCategory: failureCategory as FailureCategory,
    confidence,
    evidence: [...evidence],
    recommendedAction: recommendedAction as RecommendedAction,
    explanation,
    modelVersion,
  };
}

export interface CaseSignal {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly method?: string;
  readonly failureCode?: string;
}

export interface DiagnosisRequest {
  readonly system: string;
  readonly instruction: string;
  readonly caseId: string;
  readonly status: string;
  readonly amount: number;
  readonly currency: string;
  readonly dueAt: string;
  readonly retriesAlreadyTaken: number;
  readonly fallbackLinksAlreadyIssued: number;
  readonly signals: readonly CaseSignal[];
}

const SYSTEM_PROMPT = [
  'You diagnose failed SaaS renewal payments for a recovery control plane.',
  'You are advisory only: deterministic policy authorizes every money action, and you never execute one.',
  'Cite the signal ids you relied on. Report low confidence when the signals are ambiguous.',
  'Recommend escalate for hard declines, cancellations, disputes, or anything you cannot support from the signals.',
].join(' ');

/**
 * Projects a Recovery Case into the minimal signal set the model needs.
 * Raw provider payloads are deliberately dropped so payment credentials and
 * unnecessary personal data never reach the model.
 */
export function buildDiagnosisRequest(recoveryCase: RecoveryCase): DiagnosisRequest {
  const signals: CaseSignal[] = recoveryCase.events.map((event) => ({
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    ...(typeof event.payload.method === 'string' ? { method: event.payload.method } : {}),
    ...(typeof event.payload.failureCode === 'string' ? { failureCode: event.payload.failureCode } : {}),
  }));
  for (const attempt of recoveryCase.attempts) {
    signals.push({
      id: attempt.id,
      type: `payment_attempt_${attempt.status}`,
      occurredAt: attempt.occurredAt,
      method: attempt.method,
      ...(attempt.failureCode === undefined ? {} : { failureCode: attempt.failureCode }),
    });
  }
  return {
    system: SYSTEM_PROMPT,
    instruction: 'Diagnose this failed renewal and recommend the next bounded recovery action.',
    caseId: recoveryCase.id,
    status: recoveryCase.status,
    amount: recoveryCase.context.amount,
    currency: recoveryCase.context.currency,
    dueAt: recoveryCase.context.dueAt,
    retriesAlreadyTaken: recoveryCase.actions.filter((action) => action.kind === 'retry').length,
    fallbackLinksAlreadyIssued: recoveryCase.actions.filter((action) => action.kind === 'fallback_link').length,
    signals,
  };
}

export interface DiagnosisModel {
  readonly version: string;
  infer(request: DiagnosisRequest): Promise<unknown>;
}

export class ModelDiagnosisEngine implements DiagnosisEngine {
  constructor(private readonly model: DiagnosisModel) {}

  async diagnose(recoveryCase: RecoveryCase): Promise<Diagnosis> {
    const request = buildDiagnosisRequest(recoveryCase);
    let raw: unknown;
    try {
      raw = await this.model.infer(request);
    } catch (error) {
      if (error instanceof DiagnosisUnavailableError) throw error;
      // An unclassified transport error is assumed transient; validation failures below are terminal.
      throw new DiagnosisUnavailableError(`model call failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    const diagnosis = parseDiagnosis(raw, this.model.version);
    const knownSignals = new Set(request.signals.map((signal) => signal.id));
    if (!diagnosis.evidence.every((reference) => knownSignals.has(reference))) {
      throw new DiagnosisUnavailableError('evidence references a signal that is not on this case');
    }
    return diagnosis;
  }
}

/** Backwards-compatible name for the Anthropic transport composition. */
export class AnthropicDiagnosisEngine extends ModelDiagnosisEngine {}

export const DIAGNOSIS_TOOL = {
  name: 'record_diagnosis',
  description: 'Record the structured diagnosis for a failed renewal payment.',
  input_schema: {
    type: 'object',
    properties: {
      failureCategory: { type: 'string', enum: [...FAILURE_CATEGORIES] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      evidence: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Signal ids from the request that support this diagnosis.' },
      recommendedAction: { type: 'string', enum: [...RECOMMENDED_ACTIONS] },
      explanation: { type: 'string', description: 'One or two sentences a recovery operator can read.' },
    },
    required: ['failureCategory', 'confidence', 'evidence', 'recommendedAction', 'explanation'],
    additionalProperties: false,
  },
} as const;

export interface AnthropicModelOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMilliseconds?: number;
  readonly baseUrl?: string;
  readonly fetchImplementation?: typeof fetch;
}

/** Calls the Anthropic Messages API and forces structured output through a single tool. */
export class AnthropicMessagesModel implements DiagnosisModel {
  readonly version: string;
  private readonly apiKey: string;
  private readonly timeoutMilliseconds: number;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: AnthropicModelOptions) {
    this.version = options.model ?? 'claude-sonnet-5';
    this.apiKey = options.apiKey;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async infer(request: DiagnosisRequest): Promise<unknown> {
    const { system, instruction, ...signals } = request;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.version,
          max_tokens: 1024,
          system,
          tools: [DIAGNOSIS_TOOL],
          tool_choice: { type: 'tool', name: DIAGNOSIS_TOOL.name },
          messages: [{ role: 'user', content: `${instruction}\n\n${JSON.stringify(signals, null, 2)}` }],
        }),
      });
      if (!response.ok) {
        const retryAfterSeconds = Number(response.headers.get('retry-after'));
        throw new DiagnosisUnavailableError(`model returned HTTP ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500,
          ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? { retryAfterMilliseconds: Math.round(retryAfterSeconds * 1000) } : {}),
        });
      }
      const body = await response.json() as { content?: readonly { type?: string; name?: string; input?: unknown }[] };
      const toolUse = body.content?.find((block) => block.type === 'tool_use' && block.name === DIAGNOSIS_TOOL.name);
      if (!toolUse) throw new DiagnosisUnavailableError('model did not return a record_diagnosis tool call');
      return toolUse.input;
    } catch (error) {
      if (error instanceof DiagnosisUnavailableError) throw error;
      const aborted = controller.signal.aborted;
      throw new DiagnosisUnavailableError(aborted ? `model call timed out after ${this.timeoutMilliseconds}ms` : `model transport failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface OpenAICompatibleModelOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMilliseconds?: number;
  readonly fetchImplementation?: typeof fetch;
}

/** Calls an OpenAI-compatible Chat Completions API with one forced diagnosis function. */
export class OpenAICompatibleChatModel implements DiagnosisModel {
  readonly version: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OpenAICompatibleModelOptions) {
    this.version = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async infer(request: DiagnosisRequest): Promise<unknown> {
    const { system, instruction, ...signals } = request;
    const evidence = DIAGNOSIS_TOOL.input_schema.properties.evidence;
    const parameters = {
      ...DIAGNOSIS_TOOL.input_schema,
      properties: {
        ...DIAGNOSIS_TOOL.input_schema.properties,
        evidence: {
          ...evidence,
          items: { ...evidence.items, enum: request.signals.map((signal) => signal.id) },
        },
      },
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.version,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `${instruction}\n\n${JSON.stringify(signals, null, 2)}` },
          ],
          tools: [{
            type: 'function',
            function: {
              name: DIAGNOSIS_TOOL.name,
              description: DIAGNOSIS_TOOL.description,
              parameters,
            },
          }],
          // Pincc's gateway uses a top-level name here instead of OpenAI's nested function.name.
          tool_choice: { type: 'function', name: DIAGNOSIS_TOOL.name },
        }),
      });
      if (!response.ok) {
        const retryAfterSeconds = Number(response.headers.get('retry-after'));
        throw new DiagnosisUnavailableError(`model returned HTTP ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500,
          ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? { retryAfterMilliseconds: Math.round(retryAfterSeconds * 1000) } : {}),
        });
      }
      const body = await response.json() as {
        choices?: readonly { message?: { tool_calls?: readonly { function?: { name?: string; arguments?: string } }[] } }[];
      };
      const toolCall = body.choices?.flatMap((choice) => choice.message?.tool_calls ?? [])
        .find((call) => call.function?.name === DIAGNOSIS_TOOL.name);
      const argumentsJson = toolCall?.function?.arguments;
      if (typeof argumentsJson !== 'string') throw new DiagnosisUnavailableError('model did not return a record_diagnosis function call');
      try {
        return JSON.parse(argumentsJson) as unknown;
      } catch {
        throw new DiagnosisUnavailableError('model returned malformed record_diagnosis function arguments');
      }
    } catch (error) {
      if (error instanceof DiagnosisUnavailableError) throw error;
      const aborted = controller.signal.aborted;
      throw new DiagnosisUnavailableError(aborted ? `model call timed out after ${this.timeoutMilliseconds}ms` : `model transport failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }
}
