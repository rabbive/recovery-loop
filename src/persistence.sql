-- PostgreSQL foundation for the Recovery Case aggregate.
create table if not exists recovery_cases (
  id text primary key,
  status text not null,
  customer_id text not null,
  subscription_id text not null,
  order_id text not null,
  amount integer not null check (amount > 0),
  currency text not null,
  due_at timestamptz not null,
  recovered_amount integer not null default 0,
  outcome text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists provider_events (
  id text primary key,
  case_id text not null references recovery_cases(id),
  type text not null,
  provider_payment_id text,
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb
);

create table if not exists recovery_actions (
  id text primary key,
  case_id text not null references recovery_cases(id),
  kind text not null,
  status text not null,
  idempotency_key text not null unique,
  provider_reference text,
  expires_at timestamptz,
  result text,
  created_at timestamptz not null
);

create table if not exists audit_events (
  id text primary key,
  case_id text not null references recovery_cases(id),
  type text not null,
  actor text not null,
  at timestamptz not null,
  explanation text not null,
  data jsonb not null default '{}'::jsonb
);

create index if not exists provider_events_case_id_idx on provider_events(case_id);
create index if not exists recovery_actions_case_id_idx on recovery_actions(case_id);
create index if not exists audit_events_case_id_at_idx on audit_events(case_id, at);
