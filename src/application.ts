import { DeterministicSimulator, FixedClock, RazorpayTestModeProvider, SystemClock, type Clock, type PaymentProvider } from './provider.js';
import { createPostgresStore, type PostgresRecoveryStore } from './persistence.js';
import { DeterministicPolicy, FixtureDiagnosisEngine, InMemoryRecoveryStore, RecoveryWorkflow, type RecoveryStore } from './recovery.js';
import type { RuntimeConfig } from './config.js';

export interface RecoveryApplication {
  readonly config: RuntimeConfig;
  readonly clock: Clock;
  readonly store: RecoveryStore;
  readonly provider: PaymentProvider;
  readonly workflow: RecoveryWorkflow;
  readonly postgresStore?: PostgresRecoveryStore;
}

export interface RecoveryApplicationOptions {
  readonly config: RuntimeConfig;
  readonly clock?: Clock;
  readonly store?: RecoveryStore;
  readonly provider?: PaymentProvider;
}

export function createRecoveryApplication(options: RecoveryApplicationOptions): RecoveryApplication {
  const clock = options.clock ?? new SystemClock();
  const postgresStore = options.store === undefined && options.config.databaseUrl !== undefined ? createPostgresStore(options.config.databaseUrl) : undefined;
  const store = options.store ?? postgresStore ?? new InMemoryRecoveryStore();
  const provider = options.provider ?? (options.config.razorpayKeySecret === undefined
    ? new DeterministicSimulator(new Map(), clock)
    : new RazorpayTestModeProvider({ keyId: options.config.razorpayKeyId ?? '', keySecret: options.config.razorpayKeySecret }));
  const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), clock);
  return { config: options.config, clock, store, provider, workflow, ...(postgresStore === undefined ? {} : { postgresStore }) };
}
