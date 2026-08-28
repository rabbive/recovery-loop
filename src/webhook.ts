import type { Clock, PaymentProvider, NormalizedEventInput } from './provider.js';
import type { RecoveryCase } from './domain.js';
import type { RecoveryStore, RecoveryWorkflow } from './recovery.js';

/**
 * A delivery the boundary refused, carrying the status the caller should see. Rejections are
 * thrown rather than returned so no partially-handled delivery can reach the workflow by falling
 * through a missing check.
 */
export class WebhookRejection extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'WebhookRejection';
  }
}

export interface WebhookIngressResult {
  readonly status: 200 | 202;
  readonly duplicate: boolean;
  readonly recoveryCase: RecoveryCase;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Projects a provider webhook body into the normalized event input, or undefined when unidentifiable. */
function webhookInput(payload: Record<string, unknown>, fallbackId?: string): NormalizedEventInput | undefined {
  const objectValue = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const metadata = objectValue(payload.metadata);
  const nestedPayload = objectValue(payload.payload);
  const payment = objectValue(nestedPayload.payment);
  const entity = objectValue(payment.entity);
  const notes = objectValue(entity.notes);
  // A customer paying a fallback link produces a payment under its own id, so the link entity is
  // the only place the delivery names the action that offered it.
  const paymentLink = objectValue(objectValue(nestedPayload.payment_link).entity);
  const paymentLinkNotes = objectValue(paymentLink.notes);
  const caseId = stringValue(payload.caseId) ?? stringValue(metadata.caseId) ?? stringValue(notes.caseId);
  const id = stringValue(payload.id) ?? stringValue(payload.eventId) ?? fallbackId ?? stringValue(entity.id);
  const occurredAt = stringValue(payload.occurredAt) ?? stringValue(payload.createdAt) ?? new Date().toISOString();
  const rawType = stringValue(payload.type) ?? stringValue(payload.event);
  const type = rawType === 'payment.failed' || rawType === 'payment_failed' ? 'payment_failed'
    : rawType === 'payment.captured' || rawType === 'payment_succeeded' ? 'payment_succeeded'
      : rawType === 'payment.authorized' || rawType === 'payment_pending' ? 'payment_pending'
        : rawType === 'subscription.cancelled' || rawType === 'subscription_cancelled' ? 'subscription_cancelled'
          : rawType === 'dispute.created' || rawType === 'dispute_opened' ? 'dispute_opened' : 'unknown';
  if (!caseId || !id) return undefined;
  const providerPaymentId = stringValue(payload.providerPaymentId) ?? stringValue(entity.id);
  const providerActionReference = stringValue(payload.providerActionReference) ?? stringValue(entity.payment_link_id) ?? stringValue(paymentLink.id);
  const actionIdempotencyKey = stringValue(payload.actionIdempotencyKey) ?? stringValue(notes.recoveryActionKey) ?? stringValue(paymentLinkNotes.recoveryActionKey);
  // Razorpay nests the method and failure code on the payment entity, but the domain reads them
  // off the event payload. Lift them here so a real body can still take the retry rung.
  const method = stringValue(payload.method) ?? stringValue(entity.method);
  const failureCode = stringValue(payload.failureCode) ?? stringValue(entity.error_code) ?? stringValue(entity.error_reason);
  return {
    id, type, caseId,
    ...(providerPaymentId === undefined ? {} : { providerPaymentId }),
    ...(providerActionReference === undefined ? {} : { providerActionReference }),
    ...(actionIdempotencyKey === undefined ? {} : { actionIdempotencyKey }),
    occurredAt,
    payload: { ...payload, ...(method === undefined ? {} : { method }), ...(failureCode === undefined ? {} : { failureCode }) },
  };
}

/**
 * The provider boundary. Everything a delivery must survive before it can change a Recovery Case
 * lives here: signature verification, parsing, normalization, and the single locked call that
 * ingests and drives the case. The HTTP layer only maps the result onto a response, so the same
 * guarantees hold for the replay lab, which drives this class directly against its own isolated
 * application rather than reaching for a signing endpoint.
 *
 * A delivery cannot open a case. Renewal context is merchant data, not provider data: accepting it
 * from a webhook body would let whoever can sign a delivery invent customers, amounts, and due
 * dates. Cases are registered through the control plane, and a delivery only ever names one.
 */
export class WebhookIngress {
  constructor(
    private readonly provider: PaymentProvider,
    private readonly store: RecoveryStore,
    private readonly workflow: RecoveryWorkflow,
    private readonly clock: Clock,
  ) {}

  async handle(rawBody: string, signature: string, fallbackEventId?: string): Promise<WebhookIngressResult> {
    // Signature first: an unverified body is never parsed, stored, or orchestrated.
    if (!this.provider.verifyEvent(rawBody, signature)) throw new WebhookRejection(401, 'Invalid webhook signature');
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Webhook JSON must be an object');
      payload = parsed as Record<string, unknown>;
    } catch (error) {
      throw new WebhookRejection(400, `Invalid webhook JSON: ${String(error)}`);
    }
    const input = webhookInput(payload, fallbackEventId);
    if (!input) throw new WebhookRejection(400, 'Webhook is missing event id or case id');
    const event = this.provider.normalizeEvent(input, this.clock.now().toISOString());
    if (!(await this.store.get(event.caseId))) throw new WebhookRejection(404, `Recovery Case not found: ${event.caseId}`);
    try {
      const { recoveryCase, duplicate } = await this.workflow.ingestAndDrive(event);
      return { status: duplicate ? 200 : 202, duplicate, recoveryCase };
    } catch (error) {
      // The delivery was well-formed and named a real case, so a failure here is the loop's.
      throw new WebhookRejection(422, String(error));
    }
  }
}
