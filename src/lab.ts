import { createHmac, randomBytes } from 'node:crypto';
import type { RecoveryCase, RenewalContext } from './domain.js';
import { FixtureDiagnosisEngine } from './diagnosis.js';
import { DeterministicSimulator, FixedClock } from './provider.js';
import { DeterministicPolicy, InMemoryRecoveryStore, RecoveryWorkflow } from './recovery.js';
import { WebhookIngress, WebhookRejection } from './webhook.js';

/**
 * The webhook replay lab: synthetic deliveries that demonstrate the boundary's guarantees.
 *
 * Every scenario is a sequence of real deliveries through `WebhookIngress`, the same class the
 * public webhook route uses, so what the lab shows is the code path a Razorpay delivery takes.
 *
 * Each replay runs against a throwaway application: its own store, its own simulator with its own
 * secret, and deterministic fixture diagnosis. That isolation is the point. The lab used to sign
 * bodies through a public endpoint and deliver them to the canonical webhook, which meant a public
 * instance would hand any visitor a valid signature and let them write to the real store. Here no
 * signature ever leaves the process, and nothing a visitor replays can touch canonical figures,
 * the diagnosis model, or provider credentials.
 */

/** One delivery in a scenario, with what the boundary is expected to do about it. */
export interface LabStep {
  readonly label: string;
  /** The guarantee this delivery demonstrates, shown next to the observed result. */
  readonly expect: string;
  /** The HTTP status the boundary should answer with. */
  readonly expectStatus: number;
  readonly payload: Record<string, unknown>;
  /**
   * Whether the body should be altered *after* it is signed. Used only by the forged-delivery
   * scenario, which must fail verification rather than be accepted.
   */
  readonly tamper?: boolean;
}

export interface LabScenario {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly caseId: string;
  /**
   * The renewal the case is opened with. Merchant data, registered before any delivery arrives:
   * the boundary refuses to take it from a webhook body, and so does the lab.
   */
  readonly context?: RenewalContext;
  readonly steps: readonly LabStep[];
}

export interface LabStepResult {
  readonly label: string;
  readonly expect: string;
  readonly expectStatus: number;
  readonly status: number;
  readonly passed: boolean;
  readonly body: Record<string, unknown>;
}

export interface LabReplayResult {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly caseId: string;
  readonly steps: readonly LabStepResult[];
  readonly passed: number;
  readonly total: number;
  /** The isolated case the replay produced, or `undefined` when nothing was ever opened. */
  readonly recoveryCase?: RecoveryCase;
}

const AMOUNT = 4999;
const CURRENCY = 'INR';
/**
 * The instant every replay runs at. Fixed rather than wall-clock so two people pressing the button
 * see the same timestamps, and so a scenario's ordering cannot depend on when it was pressed.
 */
export const LAB_INSTANT = '2026-06-01T12:00:00.000Z';

function renewalContext(caseId: string): RenewalContext {
  return {
    customerId: `${caseId}-customer`,
    subscriptionId: `${caseId}-subscription`,
    orderId: `${caseId}-order`,
    amount: AMOUNT,
    currency: CURRENCY,
    dueAt: shift(LAB_INSTANT, -3600),
  };
}

function failedRenewal(caseId: string, eventId: string, occurredAt: string): Record<string, unknown> {
  return {
    id: eventId,
    type: 'payment.failed',
    caseId,
    occurredAt,
    providerPaymentId: `pay_${eventId}`,
    method: 'recurring_mandate',
    failureCode: 'insufficient_funds',
  };
}

/**
 * The renewal settling. The payment carries the simulator's retry reference because that is what a
 * charged mandate returns: without it the loop cannot tell this money from a payment made outside
 * the case, and correctly refuses to book it as recovered revenue.
 */
function capturedRenewal(caseId: string, eventId: string, occurredAt: string): Record<string, unknown> {
  return {
    id: eventId,
    type: 'payment.captured',
    caseId,
    occurredAt,
    providerPaymentId: `sim_retry_${caseId}`,
    method: 'recurring_mandate',
  };
}

/** Shifts an ISO timestamp by whole seconds, so a scenario can order its own deliveries. */
function shift(from: string, seconds: number): string {
  return new Date(Date.parse(from) + seconds * 1000).toISOString();
}

const OPEN_CASE = 'lab-open';
const DUPLICATE_CASE = 'lab-duplicate';
const ORDERING_CASE = 'lab-ordering';
const FORGED_CASE = 'lab-forged';

/**
 * The scenarios the lab offers. Fixed, because each replay gets its own throwaway application:
 * there is nothing for two runs to collide over, and a caller cannot choose the identities.
 */
export function labScenarios(): readonly LabScenario[] {
  const now = LAB_INSTANT;
  return [
    {
      key: 'open',
      title: 'A failed renewal drives a registered case',
      description: 'The merchant registered the renewal; the first signed delivery names it, and the loop diagnoses, authorizes, and executes. Renewal context never travels in the webhook body, so nobody who can sign a delivery can invent a customer or an amount.',
      caseId: OPEN_CASE,
      context: renewalContext(OPEN_CASE),
      steps: [
        {
          label: 'payment.failed',
          expect: 'Accepted, case driven',
          expectStatus: 202,
          payload: failedRenewal(OPEN_CASE, `${OPEN_CASE}-evt-1`, now),
        },
      ],
    },
    {
      key: 'duplicate',
      title: 'A redelivered event changes nothing',
      description: 'Razorpay redelivers on timeout. The same event id arriving twice must be recognised as one event: the second delivery is acknowledged but drives no further recovery action.',
      caseId: DUPLICATE_CASE,
      context: renewalContext(DUPLICATE_CASE),
      steps: [
        {
          label: 'payment.failed',
          expect: 'Accepted, case driven',
          expectStatus: 202,
          payload: failedRenewal(DUPLICATE_CASE, `${DUPLICATE_CASE}-evt-1`, now),
        },
        {
          label: 'payment.failed (identical redelivery)',
          expect: 'Acknowledged as a duplicate, no new action',
          expectStatus: 200,
          payload: failedRenewal(DUPLICATE_CASE, `${DUPLICATE_CASE}-evt-1`, now),
        },
      ],
    },
    {
      key: 'ordering',
      title: 'A late failure cannot undo a success',
      description: 'Deliveries arrive out of order. Once the renewal is captured the case is recovered, and a stale failure that was generated earlier but arrives later must not reopen it or authorize another charge. What holds here is the terminal-state rule — a recovered case accepts no further recovery action — rather than a comparison of the two timestamps.',
      caseId: ORDERING_CASE,
      context: renewalContext(ORDERING_CASE),
      steps: [
        {
          label: 'payment.failed',
          expect: 'Accepted, case driven',
          expectStatus: 202,
          payload: failedRenewal(ORDERING_CASE, `${ORDERING_CASE}-evt-1`, now),
        },
        {
          label: 'payment.captured',
          expect: 'Accepted, renewal recovered',
          expectStatus: 202,
          payload: capturedRenewal(ORDERING_CASE, `${ORDERING_CASE}-evt-2`, shift(now, 60)),
        },
        {
          label: 'payment.failed (stale, generated before the capture)',
          expect: 'Accepted but the case stays recovered',
          expectStatus: 202,
          payload: failedRenewal(ORDERING_CASE, `${ORDERING_CASE}-evt-3`, shift(now, 30)),
        },
      ],
    },
    {
      key: 'forged',
      title: 'An unsigned body never reaches the loop',
      description: 'The body is altered after it was signed, exactly as a forged delivery would be. Verification happens before the payload is parsed, looked up, or orchestrated, so nothing downstream ever sees it — the case this delivery names was never even registered, and the boundary still refuses on the signature alone.',
      caseId: FORGED_CASE,
      steps: [
        {
          label: 'payment.failed (body altered after signing)',
          expect: 'Rejected: invalid webhook signature',
          expectStatus: 401,
          payload: failedRenewal(FORGED_CASE, `${FORGED_CASE}-evt-1`, now),
          tamper: true,
        },
      ],
    },
  ];
}

export const LAB_SCENARIO_KEYS = labScenarios().map((scenario) => scenario.key);

/**
 * Runs one scenario against a throwaway application and reports what the boundary answered.
 *
 * The secret is generated per replay and never leaves this object, so the lab can sign the bodies
 * it authored and nothing else can sign anything. Diagnosis is the deterministic fixture engine:
 * a replay must never spend model credits, and a public button that did would be a way to bill the
 * operator for someone else's curiosity.
 */
export class LabRunner {
  async replay(key: string): Promise<LabReplayResult> {
    const scenario = labScenarios().find((candidate) => candidate.key === key);
    if (!scenario) throw new Error(`Unknown lab scenario: ${key}`);
    const secret = randomBytes(32).toString('hex');
    const clock = new FixedClock(LAB_INSTANT);
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator(new Map(), clock, secret);
    const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), clock);
    const ingress = new WebhookIngress(provider, store, workflow, clock);
    if (scenario.context) await workflow.openCase(scenario.caseId, scenario.context);

    const steps: LabStepResult[] = [];
    for (const step of scenario.steps) {
      const rawBody = JSON.stringify(step.payload);
      const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
      // Tampering alters the delivered bytes only, so the signature still belongs to the original.
      const delivered = step.tamper === true ? `${rawBody.slice(0, -1)},"injected":true}` : rawBody;
      const observed = await this.deliver(ingress, delivered, signature);
      steps.push({
        label: step.label,
        expect: step.expect,
        expectStatus: step.expectStatus,
        status: observed.status,
        passed: observed.status === step.expectStatus,
        body: observed.body,
      });
    }
    const recoveryCase = await store.get(scenario.caseId);
    return {
      key: scenario.key,
      title: scenario.title,
      description: scenario.description,
      caseId: scenario.caseId,
      steps,
      passed: steps.filter((step) => step.passed).length,
      total: steps.length,
      ...(recoveryCase === undefined ? {} : { recoveryCase }),
    };
  }

  private async deliver(ingress: WebhookIngress, rawBody: string, signature: string): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      const result = await ingress.handle(rawBody, signature);
      return { status: result.status, body: { accepted: true, duplicate: result.duplicate, caseId: result.recoveryCase.id, status: result.recoveryCase.status } };
    } catch (error) {
      if (error instanceof WebhookRejection) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }
}
