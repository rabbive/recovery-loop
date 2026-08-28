import { randomBytes } from 'node:crypto';
import { DeterministicSimulator, FixedClock, RazorpayTestModeProvider, SystemClock, type Clock, type PaymentProvider } from './provider.js';
import { createPostgresStore, type PostgresRecoveryStore } from './persistence.js';
import { DeterministicPolicy, InMemoryRecoveryStore, RecoveryWorkflow, type RecoveryStore } from './recovery.js';
import { AnthropicDiagnosisEngine, AnthropicMessagesModel, FixtureDiagnosisEngine, ModelDiagnosisEngine, OpenAICompatibleChatModel, type DiagnosisEngine } from './diagnosis.js';
import { InMemoryEvaluationRunStore, type EvaluationRunStore } from './evaluation.js';
import { ExpirySweeper } from './expiry.js';
import type { RuntimeConfig } from './config.js';

/**
 * What this instance is actually running, in the words the dashboard shows a visitor.
 *
 * One "Synthetic mode" badge could not say which part was synthetic, so a judge looking at a
 * Pincc-backed instance would read the AI as mocked, and a judge looking at the seeded batch would
 * read it as live. Each component is named separately, and nothing here carries a credential, a
 * base URL, or an environment value.
 */
export interface RuntimeSummary {
  readonly payments: 'Deterministic simulator' | 'Razorpay Test Mode';
  readonly liveDiagnosis: string;
  readonly seededEvaluation: 'Simulator payments · deterministic fixture diagnosis';
  readonly persistence: 'PostgreSQL' | 'In-memory (non-durable)';
  readonly recurringRetry: 'Disabled pending Test Mode proof' | 'Enabled for Test Mode proof';
}

export interface RecoveryApplication {
  readonly config: RuntimeConfig;
  readonly clock: Clock;
  readonly store: RecoveryStore;
  readonly provider: PaymentProvider;
  readonly diagnosisEngine: DiagnosisEngine;
  readonly workflow: RecoveryWorkflow;
  readonly evaluationRuns: EvaluationRunStore;
  readonly expirySweeper: ExpirySweeper;
  /** Which store this instance actually composed, so `/healthz` reports what is true rather than configured. */
  readonly persistenceMode: 'postgresql' | 'memory';
  readonly runtimeSummary: RuntimeSummary;
  readonly postgresStore?: PostgresRecoveryStore;
}

export interface RecoveryApplicationOptions {
  readonly config: RuntimeConfig;
  readonly clock?: Clock;
  readonly store?: RecoveryStore;
  readonly provider?: PaymentProvider;
  readonly diagnosisEngine?: DiagnosisEngine;
  readonly evaluationRuns?: EvaluationRunStore;
}

export function createRecoveryApplication(options: RecoveryApplicationOptions): RecoveryApplication {
  const clock = options.clock ?? new SystemClock();
  const postgresStore = options.store === undefined && options.config.databaseUrl !== undefined ? createPostgresStore(options.config.databaseUrl) : undefined;
  const store = options.store ?? postgresStore ?? new InMemoryRecoveryStore();
  const provider = options.provider ?? (options.config.razorpayKeySecret === undefined
    // Without a configured secret the simulator invents one per process, so a public instance
    // accepts no delivery anybody outside it could have signed.
    ? new DeterministicSimulator(new Map(), clock, options.config.simulatorWebhookSecret ?? randomBytes(32).toString('hex'))
    : new RazorpayTestModeProvider({
      keyId: options.config.razorpayKeyId ?? '',
      keySecret: options.config.razorpayKeySecret,
      // loadConfig refuses Razorpay credentials without it, so this is always the real secret.
      webhookSecret: options.config.razorpayWebhookSecret ?? '',
      recurringRetryEnabled: options.config.razorpayRecurringRetryEnabled,
      clock,
    }));
  const diagnosisEngine = options.diagnosisEngine ?? (options.config.pinccApiKey !== undefined
    ? new ModelDiagnosisEngine((options.config.pinccModel ?? '').startsWith('claude-')
      ? new AnthropicMessagesModel({
        apiKey: options.config.pinccApiKey,
        baseUrl: options.config.pinccBaseUrl ?? 'https://v2.pincc.ai',
        model: options.config.pinccModel ?? '',
        ...(options.config.diagnosisTimeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: options.config.diagnosisTimeoutMilliseconds }),
      })
      : new OpenAICompatibleChatModel({
        apiKey: options.config.pinccApiKey,
        baseUrl: options.config.pinccBaseUrl ?? 'https://v2.pincc.ai',
        model: options.config.pinccModel ?? '',
        ...(options.config.diagnosisTimeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: options.config.diagnosisTimeoutMilliseconds }),
      }))
    : options.config.anthropicApiKey === undefined
      ? new FixtureDiagnosisEngine()
      : new AnthropicDiagnosisEngine(new AnthropicMessagesModel({
        apiKey: options.config.anthropicApiKey,
        ...(options.config.anthropicModel === undefined ? {} : { model: options.config.anthropicModel }),
        ...(options.config.diagnosisTimeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: options.config.diagnosisTimeoutMilliseconds }),
      })));
  const workflow = new RecoveryWorkflow(store, provider, diagnosisEngine, new DeterministicPolicy(), clock);
  const persistenceMode = postgresStore === undefined ? 'memory' : 'postgresql';
  const runtimeSummary: RuntimeSummary = {
    payments: options.config.razorpayKeySecret === undefined ? 'Deterministic simulator' : 'Razorpay Test Mode',
    liveDiagnosis: options.config.pinccApiKey !== undefined
      ? `Pincc · ${options.config.pinccModel ?? 'unnamed model'}`
      : options.config.anthropicApiKey !== undefined
        ? `Anthropic · ${options.config.anthropicModel ?? 'default model'}`
        : 'Deterministic fixture engine',
    // The batch is always fixtures, whatever a live case uses, or its figures would not reproduce.
    seededEvaluation: 'Simulator payments · deterministic fixture diagnosis',
    persistence: persistenceMode === 'postgresql' ? 'PostgreSQL' : 'In-memory (non-durable)',
    recurringRetry: options.config.razorpayRecurringRetryEnabled ? 'Enabled for Test Mode proof' : 'Disabled pending Test Mode proof',
  };
  // Published batch figures live wherever the cases live, so a restart shows the same numbers.
  const evaluationRuns = options.evaluationRuns ?? postgresStore?.evaluationRuns ?? new InMemoryEvaluationRunStore();
  return { config: options.config, clock, store, provider, diagnosisEngine, workflow, evaluationRuns, expirySweeper: new ExpirySweeper(store, workflow, clock), persistenceMode, runtimeSummary, ...(postgresStore === undefined ? {} : { postgresStore }) };
}
