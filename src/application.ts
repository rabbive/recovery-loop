import { randomBytes } from 'node:crypto';
import { DeterministicSimulator, FixedClock, RazorpayTestModeProvider, SystemClock, type Clock, type PaymentProvider } from './provider.js';
import { createPostgresStore, type PostgresRecoveryStore } from './persistence.js';
import { DeterministicPolicy, InMemoryRecoveryStore, RecoveryWorkflow, type RecoveryStore } from './recovery.js';
import { AnthropicDiagnosisEngine, AnthropicMessagesModel, FixtureDiagnosisEngine, ModelDiagnosisEngine, OpenAICompatibleChatModel, type DiagnosisEngine } from './diagnosis.js';
import { InMemoryEvaluationRunStore, type EvaluationRunStore } from './evaluation.js';
import { ExpirySweeper } from './expiry.js';
import type { RuntimeConfig } from './config.js';

export interface RecoveryApplication {
  readonly config: RuntimeConfig;
  readonly clock: Clock;
  readonly store: RecoveryStore;
  readonly provider: PaymentProvider;
  readonly diagnosisEngine: DiagnosisEngine;
  readonly workflow: RecoveryWorkflow;
  readonly evaluationRuns: EvaluationRunStore;
  readonly expirySweeper: ExpirySweeper;
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
  // Published batch figures live wherever the cases live, so a restart shows the same numbers.
  const evaluationRuns = options.evaluationRuns ?? postgresStore?.evaluationRuns ?? new InMemoryEvaluationRunStore();
  return { config: options.config, clock, store, provider, diagnosisEngine, workflow, evaluationRuns, expirySweeper: new ExpirySweeper(store, workflow, clock), ...(postgresStore === undefined ? {} : { postgresStore }) };
}
