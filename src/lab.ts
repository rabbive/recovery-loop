/**
 * The webhook replay lab: synthetic deliveries that demonstrate the boundary's guarantees.
 *
 * Every scenario here is a sequence of real deliveries to `POST /webhooks/razorpay`. Nothing is
 * simulated at a lower level and nothing bypasses signature verification, so what the lab shows is
 * the same code path a Razorpay delivery takes. Each scenario carries its own case id, so it can be
 * replayed repeatedly without colliding with an earlier run.
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
  readonly steps: readonly LabStep[];
}

const AMOUNT = 4999;
const CURRENCY = 'INR';

function renewalContext(runId: string, dueAt: string): Record<string, unknown> {
  return {
    customerId: `lab-customer-${runId}`,
    subscriptionId: `lab-subscription-${runId}`,
    orderId: `lab-order-${runId}`,
    amount: AMOUNT,
    currency: CURRENCY,
    dueAt,
  };
}

function failedRenewal(caseId: string, eventId: string, occurredAt: string, context?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: eventId,
    type: 'payment.failed',
    caseId,
    occurredAt,
    providerPaymentId: `pay_${eventId}`,
    method: 'recurring_mandate',
    failureCode: 'insufficient_funds',
    ...(context === undefined ? {} : { context }),
  };
}

function capturedRenewal(caseId: string, eventId: string, occurredAt: string): Record<string, unknown> {
  return {
    id: eventId,
    type: 'payment.captured',
    caseId,
    occurredAt,
    providerPaymentId: `pay_${eventId}`,
    method: 'recurring_mandate',
  };
}

/** Shifts an ISO timestamp by whole seconds, so a scenario can order its own deliveries. */
function shift(from: string, seconds: number): string {
  return new Date(Date.parse(from) + seconds * 1000).toISOString();
}

/**
 * The scenarios the lab offers, built against one run id so repeated runs stay independent.
 *
 * `runId` should be unique per press of the button; `now` is the application clock, so the lab
 * obeys the same injected time as everything else rather than reading the wall clock itself.
 */
export function labScenarios(runId: string, now: string): readonly LabScenario[] {
  const dueAt = shift(now, -3600);
  const openCase = `lab-open-${runId}`;
  const duplicateCase = `lab-duplicate-${runId}`;
  const orderingCase = `lab-ordering-${runId}`;
  const forgedCase = `lab-forged-${runId}`;
  return [
    {
      key: 'open',
      title: 'A failed renewal opens a case',
      description: 'The first signed delivery carrying renewal context opens a Recovery Case and drives the loop. This is the entry point every other scenario builds on.',
      caseId: openCase,
      steps: [
        {
          label: 'payment.failed (with renewal context)',
          expect: 'Accepted, case opened and driven',
          expectStatus: 202,
          payload: failedRenewal(openCase, `${openCase}-evt-1`, now, renewalContext(runId, dueAt)),
        },
      ],
    },
    {
      key: 'duplicate',
      title: 'A redelivered event changes nothing',
      description: 'Razorpay redelivers on timeout. The same event id arriving twice must be recognised as one event: the second delivery is acknowledged but drives no further recovery action.',
      caseId: duplicateCase,
      steps: [
        {
          label: 'payment.failed',
          expect: 'Accepted, case opened',
          expectStatus: 202,
          payload: failedRenewal(duplicateCase, `${duplicateCase}-evt-1`, now, renewalContext(runId, dueAt)),
        },
        {
          label: 'payment.failed (identical redelivery)',
          expect: 'Acknowledged as a duplicate, no new action',
          expectStatus: 200,
          payload: failedRenewal(duplicateCase, `${duplicateCase}-evt-1`, now, renewalContext(runId, dueAt)),
        },
      ],
    },
    {
      key: 'ordering',
      title: 'A late failure cannot undo a success',
      description: 'Deliveries arrive out of order. Once the renewal is captured the case is recovered, and a stale failure that was generated earlier but arrives later must not reopen it or authorize another charge. What holds here is the terminal-state rule — a recovered case accepts no further recovery action — rather than a comparison of the two timestamps.',
      caseId: orderingCase,
      steps: [
        {
          label: 'payment.failed',
          expect: 'Accepted, case opened',
          expectStatus: 202,
          payload: failedRenewal(orderingCase, `${orderingCase}-evt-1`, now, renewalContext(runId, dueAt)),
        },
        {
          label: 'payment.captured',
          expect: 'Accepted, renewal recovered',
          expectStatus: 202,
          payload: capturedRenewal(orderingCase, `${orderingCase}-evt-2`, shift(now, 60)),
        },
        {
          label: 'payment.failed (stale, generated before the capture)',
          expect: 'Accepted but the case stays recovered',
          expectStatus: 202,
          payload: failedRenewal(orderingCase, `${orderingCase}-evt-3`, shift(now, 30)),
        },
      ],
    },
    {
      key: 'forged',
      title: 'An unsigned body never reaches the loop',
      description: 'The body is altered after it was signed, exactly as a forged delivery would be. Verification happens before the payload is parsed, stored, or orchestrated, so nothing downstream ever sees it.',
      caseId: forgedCase,
      steps: [
        {
          label: 'payment.failed (body altered after signing)',
          expect: 'Rejected: invalid webhook signature',
          expectStatus: 401,
          payload: failedRenewal(forgedCase, `${forgedCase}-evt-1`, now, renewalContext(runId, dueAt)),
          tamper: true,
        },
      ],
    },
  ];
}
