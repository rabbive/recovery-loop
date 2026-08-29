import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPostgresStore } from '../src/persistence.js';
import { DeterministicPolicy, RecoveryWorkflow, InMemoryRecoveryStore } from '../src/recovery.js';
import { DeterministicSimulator, FixedClock } from '../src/provider.js';
import { FixtureDiagnosisEngine } from '../src/diagnosis.js';
import { generateEvaluationCases, runEvaluation, toEvaluationRun } from '../src/evaluation.js';
import type { RecoveryCase } from '../src/domain.js';

const connectionString = process.env.TEST_DATABASE_URL;
const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' };

/**
 * The Postgres adapter is the only store a deployed Recovery Loop uses, and it writes seven
 * tables in one transaction. Every other test runs against the in-memory adapter, so without
 * this suite the real one is unverified. It needs a database: set TEST_DATABASE_URL to run it.
 */
const store = connectionString === undefined ? undefined : createPostgresStore(connectionString);
// The suite inspects and clears tables directly, which is the fixture's job rather than the
// store's: nothing the product does needs to truncate its own audit trail.
const fixture = connectionString === undefined ? undefined : new Pool({ connectionString });
const suite = store === undefined ? describe.skip : describe;
const tables = ['audit_events', 'recovery_actions', 'policy_decisions', 'diagnoses', 'payment_attempts', 'provider_events', 'recovery_cases', 'evaluation_runs'];
let serializationClient: PoolClient | undefined;

afterAll(async () => { await store?.close(); await fixture?.end(); });

/**
 * Runs without a database, because the failure it guards against only appears once there is one:
 * a managed Postgres refuses an unencrypted client outright, and the deployed app crashed on boot
 * with `no pg_hba.conf entry ... no encryption` until the pool asked for TLS.
 */
describe('connection encryption', () => {
  const sslOf = (connectionString: string): unknown => (createPostgresStore(connectionString) as unknown as { pool: { options: { ssl?: unknown } } }).pool.options.ssl;

  it('encrypts a managed database connection and leaves a local one alone', () => {
    expect(sslOf('postgres://user:pw@ec2-1-2-3-4.compute.amazonaws.com:5432/dbname')).toEqual({ rejectUnauthorized: false });
    expect(sslOf('postgres://postgres@127.0.0.1:5432/recovery_loop_test')).toBe(false);
    expect(sslOf('postgres://postgres:postgres@localhost:5432/recovery_loop_test')).toBe(false);
    expect(sslOf('postgresql:///recovery_loop_test')).toBe(false);
  });
});

async function rowCount(table: string, caseId: string): Promise<number> {
  const result = await fixture!.query<{ count: string }>(`select count(*) from ${table} where case_id = $1`, [caseId]);
  return Number(result.rows[0]?.count ?? '0');
}

/** Drives one failed renewal through the loop so the case carries every child record. */
async function drivenCase(): Promise<RecoveryCase> {
  const clock = new FixedClock('2026-01-01T00:00:00.000Z');
  const provider = new DeterministicSimulator(new Map([['case-1', { retry: 'failure', fallback: 'success', diagnosis: 'transient' }]]), clock);
  const workflow = new RecoveryWorkflow(new InMemoryRecoveryStore(), provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), clock);
  await workflow.openCase('case-1', context);
  await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-1', type: 'payment_failed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z', payload: { method: 'recurring_mandate', failureCode: 'insufficient_funds' } }, '2026-01-01T00:00:01.000Z'));
  await workflow.drive('case-1');
  return workflow.drive('case-1');
}

suite('PostgresRecoveryStore', () => {
  beforeEach(async () => {
    serializationClient = await fixture!.connect();
    await serializationClient.query("select pg_advisory_lock(hashtextextended('recovery-loop-test-suite', 0))");
    await store!.initialize();
    await serializationClient.query(`truncate ${tables.join(', ')} restart identity cascade`);
  });

  afterEach(async () => {
    await serializationClient?.query("select pg_advisory_unlock(hashtextextended('recovery-loop-test-suite', 0))");
    serializationClient?.release();
    serializationClient = undefined;
  });

  it('round-trips a driven case with its events, diagnosis, decisions, actions, and audit trail', async () => {
    const driven = await drivenCase();

    await store!.save(driven);

    const loaded = await store!.get('case-1');
    expect(loaded).toEqual(driven);
    expect(loaded?.actions.length).toBeGreaterThan(0);
    expect(loaded?.audit.length).toBeGreaterThan(0);
    expect(loaded?.diagnosis?.failureCategory).toBe('transient');
    expect(await store!.findLapsedFallbackCaseIds('2026-01-03T00:00:00.000Z', 100)).toContain('case-1');
    await expect(store!.healthCheck()).resolves.toBeUndefined();
  });

  it('keeps every policy decision the case recorded, including two decided in the same instant', async () => {
    // `authorize` can refuse a rung and step down to the next one, so a case carries two
    // decisions stamped at the same time. The queryable projection has to hold both, or the
    // record of why the loop chose the fallback link disappears.
    const driven = await drivenCase();
    expect(driven.decisions.length).toBeGreaterThan(1);
    expect(new Set(driven.decisions.map((decision) => decision.decidedAt)).size).toBeLessThan(driven.decisions.length);

    await store!.save(driven);

    expect(await rowCount('policy_decisions', 'case-1')).toBe(driven.decisions.length);
  });

  it('reports a case it has never stored', async () => {
    expect(await store!.get('case-nope')).toBeUndefined();
  });

  it('replaces the case on a re-save without duplicating its append-only children', async () => {
    const driven = await drivenCase();
    await store!.save(driven);

    // The workflow re-drives the same case and saves again; nothing was appended in between.
    await store!.save(driven);

    const all = await store!.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.audit).toHaveLength(driven.audit.length);
    expect(await rowCount('audit_events', 'case-1')).toBe(driven.audit.length);
    expect(await rowCount('provider_events', 'case-1')).toBe(driven.events.length);
    expect(await rowCount('recovery_actions', 'case-1')).toBe(driven.actions.length);
    expect(await rowCount('payment_attempts', 'case-1')).toBe(driven.attempts.length);
  });

  it('lists stored cases in the order they were opened', async () => {
    const first = await drivenCase();
    await store!.save(first);
    await store!.save({ ...first, id: 'case-2', createdAt: '2026-01-02T00:00:00.000Z', events: [], attempts: [], actions: [], audit: [], decisions: [] });

    expect((await store!.all()).map((recoveryCase) => recoveryCase.id)).toEqual(['case-1', 'case-2']);
  });

  it('rolls back the whole case when one child write fails', async () => {
    const driven = await drivenCase();
    const broken = { ...driven, attempts: [{ ...driven.attempts[0]!, occurredAt: 'not-a-timestamp' }] };

    await expect(store!.save(broken)).rejects.toThrow();

    expect(await store!.get('case-1')).toBeUndefined();
  });

  it('publishes an evaluation run and replays the most recent one', async () => {
    const run = toEvaluationRun(await runEvaluation(generateEvaluationCases(50, 42)), '2026-01-01T00:00:00.000Z');

    await store!.evaluationRuns.saveRun(run);
    await store!.evaluationRuns.saveRun({ ...run, metrics: { ...run.metrics, seed: 7 }, recordedAt: '2026-01-02T00:00:00.000Z' });

    const latest = await store!.evaluationRuns.latestRun();
    expect(latest?.metrics).toEqual({ ...run.metrics, seed: 7 });
    expect(latest?.recordedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(latest?.results).toHaveLength(50);
  });

  it('reports no run before a batch has been published', async () => {
    expect(await store!.evaluationRuns.latestRun()).toBeUndefined();
  });
});
