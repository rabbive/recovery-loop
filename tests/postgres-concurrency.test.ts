import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import type { RecoveryAction, RecoveryCase } from '../src/domain.js';
import { FixtureDiagnosisEngine } from '../src/diagnosis.js';
import { createPostgresStore, PostgresRecoveryStore } from '../src/persistence.js';
import { DeterministicPolicy, RecoveryWorkflow } from '../src/recovery.js';
import { DeterministicSimulator, FixedClock } from '../src/provider.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString === undefined ? describe.skip : describe;
const tables = ['audit_events', 'recovery_actions', 'policy_decisions', 'diagnoses', 'payment_attempts', 'provider_events', 'recovery_cases'];
const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' };

class GatedProvider extends DeterministicSimulator {
  callsStarted = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  override async submitRetry(recoveryCase: RecoveryCase, action: RecoveryAction) {
    this.callsStarted += 1;
    if (this.callsStarted === 1) await this.gate;
    return super.submitRetry(recoveryCase, action);
  }

  openGate(): void { this.release(); }
}

const stores: PostgresRecoveryStore[] = [];
const fixture = connectionString === undefined ? undefined : new Pool({ connectionString });
let serializationClient: PoolClient | undefined;

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await fixture?.end();
});

suite('PostgresRecoveryStore concurrency', () => {
  beforeEach(async () => {
    serializationClient = await fixture!.connect();
    await serializationClient.query("select pg_advisory_lock(hashtextextended('recovery-loop-test-suite', 0))");
    const store = stores[0] ?? (connectionString === undefined ? undefined : createPostgresStore(connectionString));
    if (!store) return;
    if (!stores.includes(store)) stores.push(store);
    await store.initialize();
    await serializationClient.query(`truncate ${tables.join(', ')} restart identity cascade`);
  });

  afterEach(async () => {
    await serializationClient?.query("select pg_advisory_unlock(hashtextextended('recovery-loop-test-suite', 0))");
    serializationClient?.release();
    serializationClient = undefined;
  });

  it('serializes drives across independent pools', async () => {
    const firstStore = createPostgresStore(connectionString!);
    const secondStore = createPostgresStore(connectionString!);
    stores.push(firstStore, secondStore);
    await firstStore.initialize();
    await secondStore.initialize();
    await fixture!.query(`truncate ${tables.join(', ')} restart identity cascade`);
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    const provider = new GatedProvider(new Map([['case-1', { retry: 'success', fallback: 'success', diagnosis: 'transient' }]]), clock);
    const diagnosis = new FixtureDiagnosisEngine();
    const policy = new DeterministicPolicy();
    const first = new RecoveryWorkflow(firstStore, provider, diagnosis, policy, clock);
    const second = new RecoveryWorkflow(secondStore, provider, diagnosis, policy, clock);
    await first.openCase('case-1', context);
    await first.ingestEvent(provider.normalizeEvent({ id: 'event-1', type: 'payment_failed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z', payload: { method: 'recurring_mandate' } }, '2026-01-01T00:00:01.000Z'));

    const firstDrive = first.drive('case-1');
    const secondDrive = second.drive('case-1');
    await Promise.resolve();
    provider.openGate();
    await Promise.all([firstDrive, secondDrive]);

    expect(provider.callsStarted).toBe(1);
    expect(provider.calls.map((action) => action.idempotencyKey)).toEqual(['case-1:retry']);
    const actions = await fixture!.query('select idempotency_key from recovery_actions where case_id = $1', ['case-1']);
    const decisions = await fixture!.query<{ allowed: boolean }>('select allowed from policy_decisions where case_id = $1 and allowed = true', ['case-1']);
    const state = await fixture!.query<{ state: RecoveryCase }>('select state from recovery_cases where id = $1', ['case-1']);
    expect(actions.rows).toHaveLength(1);
    expect(decisions.rows).toHaveLength(1);
    expect(state.rows[0]?.state.actions).toHaveLength(1);
    expect(state.rows[0]?.state.decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(state.rows[0]?.state.status).toBe('retry_scheduled');
  });
});
