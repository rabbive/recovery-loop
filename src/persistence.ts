import { readFile } from 'node:fs/promises';
import { Pool, type PoolConfig } from 'pg';
import type { RecoveryCase } from './domain.js';
import type { RecoveryStore } from './recovery.js';
import type { EvaluationRun, EvaluationRunStore } from './evaluation.js';

export class PostgresRecoveryStore implements RecoveryStore, EvaluationRunStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    const schema = await readFile(new URL('./persistence.sql', import.meta.url), 'utf8');
    await this.pool.query(schema);
  }

  async get(id: string): Promise<RecoveryCase | undefined> {
    const result = await this.pool.query<{ state: RecoveryCase }>('select state from recovery_cases where id = $1', [id]);
    return result.rows[0]?.state;
  }

  async save(recoveryCase: RecoveryCase): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const context = recoveryCase.context;
      await client.query(
        `insert into recovery_cases
          (id, status, customer_id, subscription_id, order_id, amount, currency, due_at, recovered_amount, outcome, created_at, updated_at, state)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
         on conflict (id) do update set
           status = excluded.status,
           recovered_amount = excluded.recovered_amount,
           outcome = excluded.outcome,
           updated_at = excluded.updated_at,
           state = excluded.state`,
        [recoveryCase.id, recoveryCase.status, context.customerId, context.subscriptionId, context.orderId, context.amount, context.currency, context.dueAt, recoveryCase.recoveredAmount, recoveryCase.outcome ?? null, recoveryCase.createdAt, recoveryCase.updatedAt, JSON.stringify(recoveryCase)],
      );
      for (const event of recoveryCase.events) {
        await client.query(
          `insert into provider_events (id, case_id, type, provider_payment_id, occurred_at, received_at, payload)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb) on conflict (id) do nothing`,
          [event.id, event.caseId, event.type, event.providerPaymentId ?? null, event.occurredAt, event.receivedAt, JSON.stringify(event.payload)],
        );
      }
      for (const attempt of recoveryCase.attempts) {
        await client.query(
          `insert into payment_attempts (id, case_id, provider_payment_id, method, status, failure_code, occurred_at)
           values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do nothing`,
          [attempt.id, recoveryCase.id, attempt.providerPaymentId, attempt.method, attempt.status, attempt.failureCode ?? null, attempt.occurredAt],
        );
      }
      if (recoveryCase.diagnosis) {
        const diagnosis = recoveryCase.diagnosis;
        await client.query(
          `insert into diagnoses (case_id, model_version, failure_category, confidence, evidence, recommended_action, explanation, created_at)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) on conflict do nothing`,
          [recoveryCase.id, diagnosis.modelVersion, diagnosis.failureCategory, diagnosis.confidence, JSON.stringify(diagnosis.evidence), diagnosis.recommendedAction, diagnosis.explanation, recoveryCase.updatedAt],
        );
      }
      for (const decision of recoveryCase.decisions) {
        await client.query(
          `insert into policy_decisions (case_id, action, allowed, reason, policy_version, decided_at)
           values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
          [recoveryCase.id, decision.action, decision.allowed, decision.reason, decision.policyVersion, decision.decidedAt],
        );
      }
      for (const action of recoveryCase.actions) {
        await client.query(
          `insert into recovery_actions (id, case_id, kind, status, idempotency_key, provider_reference, expires_at, result, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (id) do update set status = excluded.status, provider_reference = excluded.provider_reference, expires_at = excluded.expires_at, result = excluded.result`,
          [action.id, recoveryCase.id, action.kind, action.status, action.idempotencyKey, action.providerReference ?? null, action.expiresAt ?? null, action.result ?? null, action.createdAt],
        );
      }
      for (const audit of recoveryCase.audit) {
        await client.query(
          `insert into audit_events (id, case_id, type, actor, at, explanation, data)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb) on conflict (id) do nothing`,
          [audit.id, audit.caseId, audit.type, audit.actor, audit.at, audit.explanation, JSON.stringify(audit.data)],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveRun(run: EvaluationRun): Promise<void> {
    await this.pool.query(
      `insert into evaluation_runs (seed, dataset_version, policy_version, started_at, recorded_at, metrics, results)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [run.seed, run.datasetVersion, run.policyVersion, run.startedAt, run.recordedAt, JSON.stringify(run.metrics), JSON.stringify(run.results)],
    );
  }

  /** The batch a merchant was shown most recently. Earlier runs stay on record, unpublished. */
  async latestRun(): Promise<EvaluationRun | undefined> {
    const result = await this.pool.query<{ seed: number; dataset_version: string; policy_version: string; started_at: Date; recorded_at: Date; metrics: EvaluationRun['metrics']; results: EvaluationRun['results'] }>(
      'select seed, dataset_version, policy_version, started_at, recorded_at, metrics, results from evaluation_runs order by recorded_at desc, id desc limit 1',
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      seed: row.seed,
      datasetVersion: row.dataset_version,
      policyVersion: row.policy_version,
      startedAt: row.started_at.toISOString(),
      recordedAt: row.recorded_at.toISOString(),
      metrics: row.metrics,
      results: row.results,
    };
  }

  async all(): Promise<RecoveryCase[]> {
    const result = await this.pool.query<{ state: RecoveryCase }>('select state from recovery_cases order by created_at asc');
    return result.rows.map((row) => row.state);
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export function createPostgresStore(connectionString = process.env.DATABASE_URL, config: PoolConfig = {}): PostgresRecoveryStore {
  const poolConfig: PoolConfig = connectionString === undefined ? config : { ...config, connectionString };
  return new PostgresRecoveryStore(new Pool(poolConfig));
}
