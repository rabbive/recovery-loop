import { DeterministicSimulator, FixedClock, RazorpayTestModeProvider, SystemClock, type Clock, type PaymentProvider } from './provider.js';
import { createPostgresStore, type PostgresRecoveryStore } from './persistence.js';
import { DeterministicPolicy, InMemoryRecoveryStore, RecoveryWorkflow, type RecoveryStore } from './recovery.js';
import { AnthropicDiagnosisEngine, AnthropicMessagesModel, FixtureDiagnosisEngine, type DiagnosisEngine } from './diagnosis.js';
import { InMemoryEvaluationRunStore, type EvaluationRunStore } from './evaluation.js';
import type { RuntimeConfig } from './config.js';

export interface RecoveryApplication {
  readonly config: RuntimeConfig;
  readonly clock: Clock;
  readonly store: RecoveryStore;
  readonly provider: PaymentProvider;
  readonly diagnosisEngine: DiagnosisEngine;
  readonly workflow: RecoveryWorkflow;
  readonly evaluationRuns: EvaluationRunStore;
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
    ? new DeterministicSimulator(new Map(), clock)
    : new RazorpayTestModeProvider({
      keyId: options.config.razorpayKeyId ?? '',
      keySecret: options.config.razorpayKeySecret,
      ...(options.config.razorpayWebhookSecret === undefined ? {} : { webhookSecret: options.config.razorpayWebhookSecret }),
      clock,
    }));
  const diagnosisEngine = options.diagnosisEngine ?? (options.config.anthropicApiKey === undefined
    ? new FixtureDiagnosisEngine()
    : new AnthropicDiagnosisEngine(new AnthropicMessagesModel({
      apiKey: options.config.anthropicApiKey,
      ...(options.config.anthropicModel === undefined ? {} : { model: options.config.anthropicModel }),
      ...(options.config.diagnosisTimeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: options.config.diagnosisTimeoutMilliseconds }),
    })));
  const workflow = new RecoveryWorkflow(store, provider, diagnosisEngine, new DeterministicPolicy(), clock);
  // Published batch figures live wherever the cases live, so a restart shows the same numbers.
  const evaluationRuns = options.evaluationRuns ?? postgresStore?.evaluationRuns ?? new InMemoryEvaluationRunStore();
  return { config: options.config, clock, store, provider, diagnosisEngine, workflow, evaluationRuns, ...(postgresStore === undefined ? {} : { postgresStore }) };
}
