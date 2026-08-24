import { readFile } from 'node:fs/promises';
import { Pool, type PoolConfig } from 'pg';
import type { RecoveryCase } from './domain.js';
import type { RecoveryStore } from './recovery.js';

export class PostgresRecoveryStore implements RecoveryStore {
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
    const context = recoveryCase.context;
    await this.pool.query(
      `insert into recovery_cases
        (id, status, customer_id, subscription_id, order_id, amount, currency, due_at, recovered_amount, outcome, created_at, updated_at, state)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       on conflict (id) do update set
         status = excluded.status,
         recovered_amount = excluded.recovered_amount,
         outcome = excluded.outcome,
         updated_at = excluded.updated_at,
         state = excluded.state`,
      [
        recoveryCase.id,
        recoveryCase.status,
        context.customerId,
        context.subscriptionId,
        context.orderId,
        context.amount,
        context.currency,
        context.dueAt,
        recoveryCase.recoveredAmount,
        recoveryCase.outcome ?? null,
        recoveryCase.createdAt,
        recoveryCase.updatedAt,
        JSON.stringify(recoveryCase),
      ],
    );
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
