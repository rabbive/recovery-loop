# Razorpay Test Mode: obtaining an authorized recurring mandate token, and manufacturing a failed mandate charge

## Scope and method

Accessed 26 August 2026 (UTC). Primary sources only: pages under `razorpay.com/docs/*` and Razorpay's own API reference. No blog posts, Stack Overflow answers, or secondary write-ups were used. Every claim below is followed by the exact Razorpay URL that owns it.

Several Razorpay docs pages render their tables client-side, so the plain-text conversion of some pages omits table rows. Where that happened the page's own embedded content payload was read directly from the same URL, so the quoted rows are still that page's content — but if a table below looks stale, re-open the cited URL in a browser and re-check.

**Why this document exists.** `src/provider.ts` (`RazorpayTestModeProvider`) can only act on a case whose latest recurring-mandate attempt is `failed` and carries a `providerPaymentId`; `chargeableMandateAttempt` owns that rule. It then reads that payment with `GET /v1/payments/:id` and requires `token_id`, `customer_id`, `email`, `contact`, `amount`, and `currency`. An explicit negative `recurring` flag refuses the charge, but the undocumented absence of that field does not. The payment's customer, original order, amount, and currency must match the registered case, and its payment or order notes must name the registered subscription. So we need two things from Test Mode: an authorized token, and a **failed** payment on that token with provider identities that can be checked against the case. The failed payment is the hard part, and the docs are largely silent on it. See [Riskiest unknown](#riskiest-unknown).

---

## 1. Checklist: authorized recurring token in Test Mode

### 1.0 Prerequisites (both methods)

- [ ] Switch the Dashboard to **Test mode**. Test mode is a sandbox replica available immediately after sign-up; no real money moves, and it has its own separate set of API keys. Source: https://razorpay.com/docs/payments/dashboard/test-live-modes/ — "The Test mode is a replica of your account in a sandbox environment", "Generate API keys in Test mode to use the API keys in Test mode", "No real money is used in the test mode".
- [ ] Generate Test Mode keys (`rzp_test_...`) and export as `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`. The adapter refuses any money operation unless the key id starts with `rzp_test_` (`src/provider.ts:356-360`).
- [ ] Emandate only: confirm the method and bank are enabled. Source: https://razorpay.com/docs/payments/recurring-payments/emandate/integrate/ — prerequisites reference Razorpay Support, the Fetch Methods API, and the list of supported banks.

**Docs do not say:** there is no Razorpay page that gives a Test-Mode-specific end-to-end walkthrough for recurring mandates. The flow below is the *general* documented flow, executed with Test Mode keys.

### 1.A Cards

Reference: https://razorpay.com/docs/payments/recurring-payments/cards/integrate/ and https://razorpay.com/docs/api/payments/recurring-payments/cards/create-authorization-transaction/

The three documented phases are "Register Card Mandate", "Fetch Card Mandate Registration Details", "Charge Customers". The authorisation transaction is what mints the token.

- [ ] **Step 1 — create a customer.** `POST /v1/customers`. Required: `name`, `email`, `contact`. Returns `cust_...`.

```bash
curl -u [YOUR_KEY_ID]:[YOUR_KEY_SECRET] \
-X POST https://api.razorpay.com/v1/customers \
-H "Content-Type: application/json" \
-d '{
  "name": "<name>",
  "email": "<email>",
  "contact": "<phone>",
  "fail_existing": "0",
  "notes":{
    "note_key_1": "September",
    "note_key_2": "Make it so."
  }
}'
```
Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-authorization-transaction/

- [ ] **Step 2 — create the authorisation order.** `POST /v1/orders` with `method: "card"`, the `customer_id`, and a `token` object (`max_amount`, `expire_at`, `frequency`).

```bash
curl -u <YOUR_KEY_ID>:<YOUR_KEY_SECRET> \
-X POST https://api.razorpay.com/v1/orders \
-H "Content-Type: application/json" \
-d '{
   "amount": 100,
   "currency": "INR",
   "customer_id": "cust_4xbQrmEoA5WJ01",
   "method": "card",
   "token": {
    "max_amount": 1000000,
    "expire_at": 2709971120,
    "frequency": "monthly"
  },
   "receipt": "Receipt No. 1"
}'
```
`frequency` documented values: `weekly`, `monthly`, `yearly`, `as_presented`. Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-authorization-transaction/

- [ ] **Step 3 — run the authorisation transaction through Checkout.** The same page states: "The authorisation transaction using Standard Checkout can be created only using Razorpay APIs", and the checkout options must carry `order_id`, `customer_id`, and `recurring: true`:

```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  var options = {
    "key": "[YOUR_KEY_ID]",
    "order_id": "order_1Aa00000000001",
    "customer_id": "cust_1Aa00000000001",
    "recurring": true,
    "handler": function (response) { /* razorpay_payment_id, razorpay_order_id, razorpay_signature */ }
  };
  new Razorpay(options).open();
</script>
```
Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-authorization-transaction/

  Timing note from the same page: "For the Authorisation Payment to be successful in a day (for example, 5th June), you should create an Order and the Authorisation Transaction on the same day (5th June) before 11:59 pm."

  **Alternative that avoids hosting a checkout page:** a **Registration Link**, created via API or Dashboard. "If you use a registration link to create the authorisation transaction, Razorpay automatically creates a customer and the order for you." Registration-link states are Issued / Paid (`invoice.paid`) / Cancelled / Expired (`invoice.expired`). Source: https://razorpay.com/docs/payments/recurring-payments/cards/integrate/

- [ ] **Step 4 — pay the authorisation transaction with a test card.** In Test mode "Test mode features a mock bank page with **Success** and **Failure** buttons to replicate the live payment experience", and on the OTP screen: "Enter a random OTP between 4 to 10 digits to make the payment successful"; "Enter a random OTP below 4 digits to fail the payment". Source: https://razorpay.com/docs/payments/payments/test-card-details/

- [ ] **Step 5 — fetch the token and check its status.** "A token represents a mandate registration and is generated after the authorisation transaction is successfully captured." Token lifecycle: `initiated` → `confirmed` (→ "Create recurring payment"), or `rejected` / `cancelled` / `paused`. Source: https://razorpay.com/docs/payments/recurring-payments/cards/integrate/

  Fetch tokens for a customer: `GET /v1/customers/:id/tokens` — the token entity carries `recurring: true`, `recurring_details.status` (`initiated` / `confirmed` / `rejected`) and `recurring_details.failure_reason`. Note: "This endpoint will not fetch the details of expired, rejected and unused tokens." Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/tokens/

### 1.B Emandate

Reference: https://razorpay.com/docs/payments/recurring-payments/emandate/integrate/ and https://razorpay.com/docs/api/payments/recurring-payments/emandate/create-authorization-transaction/

- [ ] **Step 1 — create a customer** (identical `POST /v1/customers` call as above).
- [ ] **Step 2 — create the authorisation order** with `method: "emandate"`, `amount: 0` (zero-rupee registration), and a `token` object containing `auth_type`, `max_amount`, `expire_at`, and `bank_account`:

```bash
curl -u <YOUR_KEY_ID>:<YOUR_KEY_SECRET> \
-X POST https://api.razorpay.com/v1/orders \
-H "Content-Type: application/json" \
-d '{
  "amount": 0,
  "currency": "INR",
  "payment_capture": true,
  "method": "emandate",
  "customer_id": "cust_1Aa00000000001",
  "receipt": "Receipt No. 1",
  "token": {
    "auth_type": "aadhaar",
    "max_amount": 9999900,
    "expire_at": 4102444799,
    "bank_account": {
      "beneficiary_name": "Gaurav Kumar",
      "account_number": "1121431121541121",
      "account_type": "savings",
      "ifsc_code": "HDFC0000001"
    }
  }
}'
```
Source: https://razorpay.com/docs/api/payments/recurring-payments/emandate/create-authorization-transaction/ — "Aadhaar authentication type is enabled by default for your Razorpay account." The same page shows the identical body with `"auth_type": "netbanking"`, and a variant carrying `"first_payment_amount": 0`.

- [ ] **Step 3 — customer completes authentication.** Three documented auth types: Aadhaar (recommended — "eliminates the traditional 2-4 day manual approval process, delivering instant registration confirmation in minutes"), Netbanking, and Debit Card. Source: https://razorpay.com/docs/payments/recurring-payments/emandate/integrate/
- [ ] **Step 4 — authorisation payment states.** Created (no webhook) → Authorized (`payment.authorized`) → Captured (`payment.captured`, `order.paid`, token retrievable) or Failed (`payment.failed`). Source: https://razorpay.com/docs/payments/recurring-payments/subscribe-to-webhooks/
- [ ] **Step 5 — fetch the token**, same states as cards.

**Docs do not say:** no Razorpay page reviewed gives Test Mode bank account numbers, IFSC codes, test Aadhaar numbers, netbanking credentials, or a mock-bank walkthrough for emandate. The account number and IFSC in the API example (`1121431121541121`, `HDFC0000001`) are illustrative request samples, **not** documented Test Mode credentials. The `razorpay.com/docs/payments/payments/test-card-details/` page covers cards only; there is no equivalent "test emandate details" page (`/recurring-payments/emandate/test-integration/` returns 404).

**Implication for this repo:** cards is the only mandate method with a documented Test Mode instrument. Prefer the card mandate path for the demo.

---

## 2. Test instruments: what succeeds, what fails

### 2.1 The success/failure lever at authorisation

The documented mechanism is the mock bank page, not the card number. Source: https://razorpay.com/docs/payments/payments/test-card-details/

- Mock bank page has **Success** and **Failure** buttons.
- OTP screen: random OTP of **4–10 digits → payment succeeds**; **below 4 digits → payment fails**.
- Any random CVV; any future expiry date.

### 2.2 Test cards for Indian payments (successful authorisation)

| Network | Card number | Type | Sub type |
| --- | --- | --- | --- |
| Visa | 4100 2800 0000 1007 | Debit | Consumer |
| Mastercard | 5555 5100 0008 1006 | Credit | Business |
| Mastercard | 5180 2872 0009 1001 | Prepaid | Consumer |
| RuPay | 6527 6589 0000 1005 | Credit | Consumer |
| Diners | 3608 280009 1007 | Credit | Consumer |
| Amex | 3402 560004 01007 | Credit | Consumer |

Source: https://razorpay.com/docs/payments/payments/test-card-details/ ("Test Cards for Indian Payments").

### 2.3 Test cards for Subscriptions

| Type | Network | Card type | Card number |
| --- | --- | --- | --- |
| Domestic | Visa | Credit | 4718 6091 0820 4366 |
| International | Mastercard | Credit | 5104 0155 5555 5558 |
| International | Mastercard | Debit | 5104 0600 0000 0008 |

Source: https://razorpay.com/docs/payments/payments/test-card-details/ ("Test Cards for Subscriptions"). **Docs do not say** whether these are the cards to use for a *recurring-payments* (non-Subscriptions) card mandate; the section is titled "Subscriptions" and the recurring-payments docs never point at it.

### 2.4 Error-scenario test cards

These are the only documented way to force a *specific* declined outcome. The page's own instruction: "Once you initiate the payment, in success/failure screen, you must select failure to get the right error."

`BAD_REQUEST_ERROR`:

| Error reason | Visa | Mastercard |
| --- | --- | --- |
| `payment_timed_out` | 4100 2800 0009 0000 | 5305 6200 0006 0000 |
| `insufficient_fund` | 4100 2800 0008 0001 | 5305 6200 0005 0001 |
| `payment_cancelled` | 4100 2800 0007 0002 | 5305 6200 0004 0002 |
| `card_declined` | 4100 2800 0006 0003 | 5305 6200 0003 0003 |
| (further `card_declined` rows) | 4100 2800 0005 0004 | 5305 6200 0002 0004 |
| (further `card_declined` rows) | 4100 2800 0004 0005 | 5305 6200 0001 0005 |
| `card_disabled_for_online_payments` | 4100 2800 0003 0006 | 5305 6200 0000 0006 |
| `card_number_invalid` | 4100 2800 0001 0008 | 5305 6200 0008 0008 |

`GATEWAY_ERROR`:

| Error reason | Visa | Mastercard |
| --- | --- | --- |
| `gateway_technical_error` | 4100 2800 0002 0007 | 5305 6200 0009 0007 |
| `authentication_failed` | 4100 2800 0000 0009 | 5305 6200 0007 0009 |

Source: https://razorpay.com/docs/payments/payments/test-card-details/ ("Error Scenarios").

`insufficient_fund` (Visa `4100 2800 0008 0001`) is the closest documented analogue of a real renewal decline.

### 2.5 The gap that matters most for this repo

**Docs do not say** how to force a **failed subsequent/recurring debit** on an already-authorized token in Test Mode.

Everything above governs the *interactive* authorisation transaction at Checkout, where a customer-facing mock bank page and an OTP field exist. `POST /v1/payments/create/recurring` is a server-to-server call with no OTP screen and no mock bank page — there is nowhere to press "Failure", and the request body carries no card number, so the error-scenario cards have no injection point.

Two things the docs *do* say that bear on it, neither of which is a confirmed recipe:

- The card mandate is registered against a specific card, so an error-scenario card *could* in principle be used for the authorisation transaction itself and then charged. **Docs do not state** whether a mandate registered on an error-scenario card can be authorized at all, nor what a subsequent debit on such a token returns.
- On pre-debit notifications: "We will not attempt any retry if the debit fails for tokens with the notification object in the created order. You should manually retry the debit attempt." Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-subsequent-payments/ — this confirms debits *can* fail and that retry is the merchant's job, but it does not say how to induce that failure in Test Mode.

**Documented API-level errors that are *not* failed payments** (they are `BAD_REQUEST` responses to the charge call, so they produce no payment id and cannot seed a `chargeableMandateAttempt`):

| Error | Cause (verbatim) |
| --- | --- |
| `pre_debit_notification_not_sent` | "This error occurs when a pre-debit notification is not sent and a debit attempt is made." |
| `BAD_REQUEST_MANDATE_PROMISED_DEBIT_DATE_NOT_HONOURED` | "This error occurs when you attempt a debit within 36 hours and 5 minutes of a notification being delivered." |
| `BAD_REQUEST_ERROR` / "Amount exceeds maximum amount allowed" | sample error response on the same page (charging above the mandate's `max_amount`) |

Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-subsequent-payments/

For the adapter this matters: these surface at `src/provider.ts:292` as `status: 'failed'` with Razorpay's description, which is correct behaviour — but they never create the *prior* failed payment the adapter needs as input.

### 2.6 Retry semantics Razorpay itself documents

- "Payment re-tries are not automated. You can manually re-initiate the payment for the same order id in case of a failed payment after 36 hours of initiating the previous payment."
- "You can manually re-initiate a payment for the same order id, repeatedly, every 36 hours, until the payment is successful."

Source: https://razorpay.com/docs/payments/recurring-payments/cards/faqs/

**Implementation choice, revised 2026-08-29:** this FAQ conflicts with the create-subsequent-payment reference in section 3.2, which says, "You have to create a new order every time you want to charge your customers." The adapter follows that API reference. It verifies that the original failed payment belongs to the registered customer, order, subscription, amount, and currency, then creates a fresh order whose `receipt` is the recovery action identity. A replay accepts that order only when its receipt, notes, amount, and currency still match the action and registered case, then treats any payment on it, including `created` or `failed`, as the same submitted action. This prevents a process-crash replay from issuing a second charge. A duplicate-order response is resolved through the same lookup. The implementation therefore does **not** perform the FAQ's same-order retry operation, and it does not model the 36-hour spacing. Recurring retry remains disabled pending the live proof gate below.

---

## 3. `GET /v1/payments/:id` response shape vs. the adapter's five required fields

Source: https://razorpay.com/docs/api/payments/fetch-with-id/

| Field the adapter requires (`src/provider.ts:339-346`) | Documented on the fetch-payment page? |
| --- | --- |
| `token_id` | **Yes.** "Unique identifier of the token associated with this payment." Appears in the card example response as `"token_id": "token_KOdY$DBYQOv08n"`. |
| `customer_id` | **Yes.** "Unique identifier of the customer associated with this payment." Appears as `"customer_id": "cust_K6fNE0WJZWGqtN"`. |
| `email` | **Yes.** "Customer email address used for the payment." |
| `contact` | **Yes.** "Customer contact number used for the payment." |
| `recurring` | **No — not documented at all.** |

**This is the sharpest finding in this document.** The word `recurring` does not appear anywhere in the content of https://razorpay.com/docs/api/payments/fetch-with-id/ — not in any example response, and not in the response-parameter list. The documented `status` enum is `created`, `authorized`, `captured`, `refunded`, `failed`; the documented `method` enum is `card`, `netbanking`, `wallet`, `emi`, `upi`, `paylater`. There is no `recurring` attribute.

The card example response on that page (a payment that *does* carry `token_id` and `customer_id`) is:

```json
{
  "id": "pay_DG4ZdRK8ZnXC3k",
  "entity": "payment",
  "amount": 100,
  "currency": "INR",
  "status": "captured",
  "order_id": "order_GjCr5oKh4AVC51",
  "invoice_id": null,
  "international": false,
  "method": "card",
  "amount_refunded": 0,
  "refund_status": null,
  "captured": true,
  "description": "Payment for Adidas shoes",
  "card_id": "card_KOdY30ajbuyOYN",
  "bank": null,
  "wallet": null,
  "vpa": null,
  "email": "gaurav.kumar@example.com",
  "contact": "9000090000",
  "customer_id": "cust_K6fNE0WJZWGqtN",
  "token_id": "token_KOdY$DBYQOv08n",
  "notes": [],
  "fee": 1,
  "tax": 0,
  "error_code": null,
  "error_description": null,
  "error_source": null,
  "error_step": null,
  "error_reason": null,
  "acquirer_data": {
      "auth_code": "064381",
      "arn": "74119663031031075351326",
      "rrn": "303107535132"
  },
  "created_at": 1605871409
}
```

Corroborating negative: `recurring` also does not appear in the payment entities embedded in Razorpay's own webhook payload samples (https://razorpay.com/docs/webhooks/payloads/payments/), which do carry `token_id`.

Where `recurring` *is* documented as a real field:

- **The token entity**, as `recurring: true` plus `recurring_details.status` (`initiated` / `confirmed` / `rejected`) and `recurring_details.failure_reason`. Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/tokens/
- **The Checkout options object**, as `recurring: true`. Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-authorization-transaction/
- **The `POST /v1/payments/create/recurring` request body**, as a boolean. Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-subsequent-payments/

**Docs do not say** that `recurring` is absent from the payment response, only that it is undocumented. Razorpay's API may return it, but this document will not assert that from an unsourced position. The adapter now treats absence as unknown and accepts the documented truthy shapes it may receive; only an explicit negative refuses the charge. `token_id` remains the required mandate proof in the fetched payment.

Recommended follow-up (verification, not doc reading): call `GET /v1/payments/:id` against a real Test Mode recurring payment and inspect the raw JSON. If `recurring` is absent, the documented alternative is to confirm the mandate through the token instead — `GET /v1/customers/:customer_id/tokens` and check `recurring === true` / `recurring_details.status === "confirmed"`, which *is* documented.

---

## 4. Is `POST /v1/payments/create/recurring` still current?

**Yes.** It is the live, current endpoint on both the cards and emandate API reference pages as of the access date.

- Cards: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-subsequent-payments/
- Emandate: https://razorpay.com/docs/api/payments/recurring-payments/emandate/create-subsequent-payments/

Both pages document `/payments/create/recurring` under section "3.2. Create a Recurring Payment", and both instruct you to create a **new** order first: "You have to create a new order every time you want to charge your customers. This order is different from the one created during the authorisation transaction."

Exact documented request:

```bash
curl -u [YOUR_KEY_ID]:[YOUR_KEY_SECRET] \
-X POST https://api.razorpay.com/v1/payments/create/recurring \
-H "Content-Type: application/json" \
-d '{
  "email": "<email>",
  "contact": "<phone>",
  "amount": 1000,
  "currency": "<currency>",
  "order_id": "order_1Aa00000000002",
  "customer_id": "cust_1Aa00000000001",
  "token": "token_1Aa00000000001",
  "recurring": true,
  "description": "Creating recurring payment for <name>",
  "notes": {
    "note_key 1": "Beam me up Scotty",
    "note_key 2": "Tea. Earl Gray. Hot."
  }
}'
```

Required fields (marked required in the reference): `email` (string), `contact` (integer), `currency` (string, `INR`), `amount` (integer), `order_id` (string), `customer_id` (string), `token` (string), `recurring` (boolean). Optional: `description` (string), `notes` (object, max 15 pairs, 256 chars each).

Documented response parameters: `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`. Success sample on the cards page shows only `{"razorpay_payment_id": "pay_1Aa00000000001"}`, but the emandate page's Watch Out callout is explicit: "You will receive `razorpay_payment_id`, `razorpay_order_id` and `razorpay_signature` as a response when you create a Recurring Payment in **Test mode**." Source: https://razorpay.com/docs/api/payments/recurring-payments/emandate/create-subsequent-payments/

**Implementation check:**

- The adapter sends boolean `recurring: true`, matching both API reference pages and their SDK samples.
- The adapter reads only `razorpay_payment_id`, which is fine because it is a documented, required response field.
- Emandate caveat the adapter should be aware of: for emandate, "the payment entity returned is in the created state and may take 1 working day for confirmation." Source: https://razorpay.com/docs/payments/recurring-payments/emandate/integrate/ — consistent with the adapter reporting only `submitted`.
- Optional pre-debit notification: `POST /v1/orders` accepts a `notification` object (`token_id`, `payment_after`). "The TAT to create a debit if you send a pre-debit notification is 36 hours and 5 minutes." Source: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-subsequent-payments/ — the adapter does not send `notification`, which is consistent with the docs treating it as optional, but see the `pre_debit_notification_not_sent` error in §2.5 and the ₹15,000 threshold below.

---

## 5. Webhooks against a local dev server

Source: https://razorpay.com/docs/webhooks/setup-edit-payments/ and https://razorpay.com/docs/webhooks/validate-test/

### 5.1 Setup checklist

- [ ] Dashboard → **Accounts & Settings** → **Webhooks** (under *Website and app settings*) → **+ Add New Webhook**.
- [ ] Enter the **URL**, a **Secret**, an **Alert Email**, and select **Active Events**, then **Create Webhook**.
- [ ] In Test mode, entering or editing a webhook prompts for an OTP: "Enter the default OTP `754081` when prompted, while setting up, editing or deleting a webhook in test mode."
- [ ] Limit: up to **30 URLs**.
- [ ] Deactivation: Razorpay disables a webhook that stops returning `2XX`, and emails the configured alert address.

### 5.2 Tunnelling to localhost — read this before reaching for ngrok

"You cannot use localhost directly to receive webhook events as webhook delivery requires a public URL. Due to security restrictions, many common tunneling services are blacklisted. You can handle this by creating a tunnel to your localhost using `zrok`." Source: https://razorpay.com/docs/webhooks/validate-test/ (links to https://docs.zrok.io/docs/zrok/getting-started)

Blacklisted domains, verbatim from that page:

`burpcollaborator.net`, `oast.pro`, `interact.sh`, `canarytokens.com`, `requestbin.com`, `webhook.site`, `hookbin.com`, `beeceptor.com`, `mockbin.org`, `ngrok.io`, `loca.lt`, `metadata.google.internal`, `metadata.google.internal.`, `localhost`, `localhost.localdomain`, `.onion`, `.local`, `.internal`, `.corp`

**`ngrok.io` is blacklisted. `zrok` is the documented option.** Note the page lists `ngrok.io` specifically and **does not say** anything about ngrok's current default domains (`*.ngrok-free.app`, `*.ngrok.app`) or about a paid ngrok custom domain — treat their status as unknown rather than allowed.

The same page also offers two non-tunnel routes: request-interceptor services (but the popular ones are on the blacklist above) and a staging environment configured in Test mode.

### 5.3 Webhook secret vs. API key secret — the precise distinction

Razorpay states it outright: **"The webhook secret does not need to be the Razorpay API key secret."** Source: https://razorpay.com/docs/webhooks/setup-edit-payments/

| | API key secret | Webhook secret |
| --- | --- | --- |
| Where it comes from | Generated with the key id under API Keys; one per mode | **You choose it** in the Add/Edit Webhook form, per webhook |
| What it authenticates | Your outbound calls to `api.razorpay.com` (HTTP Basic: `key_id:key_secret`) | Razorpay's inbound calls to you |
| How it is used | Basic auth credential | HMAC key |
| Optional? | No | "Entering the secret is optional but recommended" |

Signature computation, verbatim: "The hash signature is calculated using HMAC with SHA256 algorithm; with your webhook secret set as the key and the webhook request body as the message", delivered in the `X-Razorpay-Signature` header:

```
key                = webhook_secret
message            = webhook_body // raw webhook request body
received_signature = webhook_signature

expected_signature = hmac('sha256', message, key)

if expected_signature != received_signature
    throw SecurityError
end
```

Two further verbatim warnings that the adapter already respects or should:

- "Do not parse or cast the webhook request body" — verify against the **raw** body. The adapter's `verifyEvent` takes `raw` (`src/provider.ts:193`), which is correct.
- "If you have changed your webhook secret, remember to use the old secret for webhook signature validation while retrying older requests. Using the new secret will lead to a signature mismatch."
- Idempotency: "Verify if an event with the same header is processed at your end", using `x-razorpay-event-id`. The HTTP boundary already dedupes on that header.

**Flag against the implementation — resolved:** the adapter used to fall back to `keySecret` when `webhookSecret` was unset. Razorpay's docs say the two "do not need" to be the same and never suggest the key secret as a webhook secret. `webhookSecret` is now a required field on `RazorpayTestModeOptions` — `loadConfig` throws `RAZORPAY_WEBHOOK_SECRET must be configured alongside the Razorpay API credentials` whenever Razorpay credentials are present, and the fallback is gone.

Recurring-specific events to subscribe to (from https://razorpay.com/docs/payments/recurring-payments/subscribe-to-webhooks/): `payment.authorized`, `payment.captured`, `order.paid`, `payment.failed`, `invoice.paid`, `invoice.expired`, and `token.confirmed`.

Delivery ordering, verbatim: "Ideally, you should receive a webhook in the order in which the webhook events occur. However, you may not always receive the webhooks in the order." — consistent with the ordering rules already documented in this repo's README.

---

## 6. Test Mode limitations on mandates

Documented:

- **Card token validity is 3 days in Test mode.** "In test mode, you can perform a subsequent debit only within 3 days of token creation, as card tokens are valid for 3 days only." Source: https://razorpay.com/docs/payments/payments/test-card-details/ — this is a hard limit on the demo: a token minted more than 3 days before the demo cannot be charged.
- **Test cards only work in Test mode.** In live mode they produce "card issuer is invalid" or "invalid card input". Source: same page.
- **Test and Live mode have entirely separate API keys.** Source: https://razorpay.com/docs/payments/dashboard/test-live-modes/
- **Webhook URL must be publicly reachable and must not be a blacklisted domain** (§5.2). Source: https://razorpay.com/docs/webhooks/validate-test/
- **Webhook dashboard edits in Test mode require OTP `754081`.** Source: same page.

Constraints that are documented as *product* rules, not Test-Mode-specific, but which still bind a Test Mode demo:

- Card mandate ceiling: mandates up to **₹15,000** register and debit without customer intervention. Source: https://razorpay.com/docs/payments/recurring-payments/cards/faqs/
- Pre-debit notification TAT: raise the debit request **36 hours** in advance; the documented notification TAT is **36 hours and 5 minutes**. Sources: https://razorpay.com/docs/payments/recurring-payments/cards/faqs/ and https://razorpay.com/docs/api/payments/recurring-payments/cards/create-subsequent-payments/
- Failed-payment retry cadence: manual, **every 36 hours**, same order id (§2.6).
- RuPay recurring is a beta with on-demand enablement and explicitly does **not** support "Payment retries", "Debits greater than 15K", "Mandate registration with saved card". Source: https://razorpay.com/docs/payments/recurring-payments/cards/faqs/ — avoid RuPay for this repo's retry demo.
- Emandate authorisation can take 2–4 days unless Aadhaar auth is used. Source: https://razorpay.com/docs/payments/recurring-payments/emandate/integrate/
- Emandate subsequent payments return a payment in `created` state and "may take 1 working day for confirmation". Source: same page.

**Docs do not say** (each of these is a genuine silence, not an inference):

- Whether the 36-hour retry spacing and pre-debit-notification TAT are enforced, shortened, or bypassed in Test mode.
- Whether emandate mandates can be authorized at all in Test mode, and with what credentials.
- Whether a card mandate registered on an error-scenario card can be authorized, and what a subsequent debit on it returns.
- Whether `POST /v1/payments/create/recurring` in Test mode ever produces a payment that reaches `status: "failed"`, or only ever succeeds.
- Whether `token.rejected` / `token.paused` / mandate cancellation can be exercised in Test mode.
- Whether the ₹15,000 no-intervention ceiling applies in Test mode.

---

## Empirical result: card mandate registration is refused on this account (2026-08-28)

Reproduced today against this project's live Test Mode credentials, superseding the uncertainty
below for step 1 of the proof gate. Three independent paths were tried:

1. `POST /v1/orders` with `method: "card"`, a `customer_id`, and a `token` block
   (`max_amount`/`expire_at`/`frequency`) — **succeeds without error** and returns the order with the
   `token` block echoed back. Creating the order artifact is not gated.
2. Standard Checkout against that order, loaded via `checkout.js` with
   `order_id`, `customer_id`, and `recurring: true` — the documented mechanism (§1.A Step 3) — **fails
   at the payment-method selection screen** with the dialog **"No appropriate payment method
   found."** No card entry field is ever shown; the checkout cannot proceed to authorize anything.
3. A hosted registration link created via `POST /v1/invoices` (`type: "link"`) with the same `token`
   block — the invoice is issued and shows a valid `short_url`, but the **`token` field is silently
   dropped**: the order Razorpay auto-creates behind the link carries no `token` block at all, so
   paying that link (which does succeed, as a plain one-time payment) produces a payment with no
   `token_id`, no `customer_id`, and no `recurring` field — not a mandate under any interpretation,
   and not something `chargeableMandateAttempt`'s downstream `readMandate` guard would accept.

**Conclusion:** recurring card-mandate registration is not enabled on this account, independent of
integration correctness. The order/token JSON can be constructed freely, but Standard Checkout
itself refuses to offer a payment method once `recurring: true` is requested — the same refusal the
account showed two days earlier when this document was first researched. This is an account-level
capability question that only Razorpay support can change; there is no self-service path found in
the API or dashboard that enables it. `RAZORPAY_RECURRING_RETRY_ENABLED` stays `false` and step 1 of
the proof gate below (below) is the blocker: nothing past it can be attempted until Razorpay confirms
recurring card payments are enabled for this account.

---

## Riskiest unknown

**How to get a `failed` payment on an authorized Test Mode token — the exact input `chargeableMandateAttempt` requires.**

Razorpay documents a rich set of failure levers for the *interactive authorisation* payment (mock bank Failure button, sub-4-digit OTP, error-scenario card numbers) and a rich set of *API validation* errors for the recurring charge call. It documents **nothing** about producing a payment that reaches `status: "failed"` from a server-to-server recurring debit in Test mode. That is precisely the state the adapter needs to exist *before* it will act.

Candidate approaches, in descending order of plausibility, all requiring empirical verification against Test Mode (none of them documented):

1. Register the card mandate using an error-scenario card (e.g. `insufficient_fund` Visa `4100 2800 0008 0001`), authorize it via the mock bank Success path, then charge it and see whether the subsequent debit fails.
2. Charge above the mandate's `max_amount` — documented to return `BAD_REQUEST_ERROR` "Amount exceeds maximum amount allowed", which is an API error with **no payment id**, so it does *not* satisfy `chargeableMandateAttempt` and cannot be used to seed one.
3. Let the 3-day Test Mode token expiry lapse and then charge — outcome undocumented, and likely also an API error rather than a failed payment.
4. Synthesise the failed attempt: post a signed `payment.failed` webhook to the local endpoint carrying a `providerPaymentId` that points at a **real** Test Mode payment which itself carries a valid mandate. This is the only path that does not depend on an undocumented Test Mode behaviour, and it is how the repo's existing contract tests already work.

**Secondary risk, coupled to the above:** even with a genuine failed mandate payment in hand, its customer, original order, and subscription notes must match the registered Recovery Case before the adapter will create an order. Record the sanitized identity fields from a real Test Mode recurring payment and order so the proof verifies this fail-safe path rather than bypassing it.

---

## Source register (primary sources, all accessed 2026-08-26)

1. Recurring Payments overview: https://razorpay.com/docs/payments/recurring-payments/
2. Recurring Payments — Cards, integration guide: https://razorpay.com/docs/payments/recurring-payments/cards/integrate/
3. Recurring Payments — Cards, FAQs: https://razorpay.com/docs/payments/recurring-payments/cards/faqs/
4. API — Cards, create authorization transaction: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-authorization-transaction/
5. API — Cards, create subsequent payments: https://razorpay.com/docs/api/payments/recurring-payments/cards/create-subsequent-payments/
6. API — Cards, tokens: https://razorpay.com/docs/api/payments/recurring-payments/cards/tokens/
7. Recurring Payments — Emandate, integration guide: https://razorpay.com/docs/payments/recurring-payments/emandate/integrate/
8. API — Emandate, create authorization transaction: https://razorpay.com/docs/api/payments/recurring-payments/emandate/create-authorization-transaction/
9. API — Emandate, create subsequent payments: https://razorpay.com/docs/api/payments/recurring-payments/emandate/create-subsequent-payments/
10. Recurring Payments — subscribe to webhooks: https://razorpay.com/docs/payments/recurring-payments/subscribe-to-webhooks/
11. API — Fetch a payment with id: https://razorpay.com/docs/api/payments/fetch-with-id/
12. API reference index — Payments: https://razorpay.com/docs/api/payments/
13. Test card details: https://razorpay.com/docs/payments/payments/test-card-details/ (canonical target of `/payments/payments/test-card-upi-details/`)
14. Test mode vs Live mode: https://razorpay.com/docs/payments/dashboard/test-live-modes/
15. Webhooks index: https://razorpay.com/docs/webhooks/
16. Set up and edit payments webhooks: https://razorpay.com/docs/webhooks/setup-edit-payments/
17. Validate and test webhooks: https://razorpay.com/docs/webhooks/validate-test/
18. Webhook payloads — payments: https://razorpay.com/docs/webhooks/payloads/payments/
19. zrok getting started (linked *by* Razorpay's own docs as the localhost tunnel): https://docs.zrok.io/docs/zrok/getting-started

URLs checked and confirmed **404** (so no such page exists to cite): `/docs/payments/recurring-payments/cards/test-details/`, `/docs/payments/recurring-payments/cards/test-integration/`, `/docs/payments/recurring-payments/emandate/test-integration/`, `/docs/payments/recurring-payments/emandate/`, `/docs/payments/recurring-payments/faqs/`, `/docs/payments/recurring-payments/handle-errors/`, `/docs/payments/subscriptions/test-integration/`, `/docs/api/payments/payments/fetch-with-id/`.

## Research limitations

- razorpay.com was reachable throughout; nothing in this document is recalled rather than sourced. Where a source could not be found, the document says "docs do not say" rather than filling the gap.
- No authenticated Razorpay Dashboard access, no Test Mode API keys, and no live API calls were used. Every "docs do not say" item is a documentation gap, not a tested negative — several are cheap to resolve with one Test Mode call and should be resolved that way rather than by more reading.
- Razorpay's docs are region- and account-dependent (the site advertises IN/MY/SG/US variants). This review read the default India variant.

## Live recurring retry proof gate

The recurring mandate charge is implemented from Razorpay's API reference and has **not** been run
against the account. `RAZORPAY_RECURRING_RETRY_ENABLED` therefore defaults to `false`, and while it
is false the adapter refuses the charge without making a network call: policy steps the case down
to the fallback payment link, which *has* been exercised against Test Mode.

The flag may be enabled only after every check below has been completed and recorded here. Record
dates, sanitized request and response shapes, and identifiers — never secrets, card numbers, or
customer contact details.

1. Obtain Razorpay confirmation that recurring card payments are enabled on the Test Mode account.
   **Blocked as of 2026-08-28** — see [Empirical result](#empirical-result-card-mandate-registration-is-refused-on-this-account-2026-08-28)
   above. Standard Checkout itself refuses to offer a payment method for an order requesting
   `recurring: true`, on a freshly created order, tried three independent ways. This is not an
   integration defect in this repo: the refusal happens before any card is entered. Resolving it
   requires a Razorpay support request to enable recurring card payments on this Test Mode account;
   nothing in the API or dashboard self-service surface enables it.
2. Create a Test Mode customer and complete a card-mandate authorization transaction.
3. Fetch the customer token and record a sanitized response showing a confirmed recurring mandate.
4. Create a subsequent Test Mode payment using the documented recurring API and record its payment id.
5. Produce or identify a failed subsequent mandate payment, wait the provider-required interval
   where applicable, and pre-register its Recovery Case with the same amount, currency, customer,
   subscription, and order context.
6. Run `tests/razorpay-recurring-proof.test.ts` with that payment id and context. It must submit one
   retry, return a real `pay_...` reference, and resolve a replayed action identity to the same
   payment rather than creating a second one.
7. Deliver a valid Razorpay-signed success webhook for that payment id and confirm the case records
   `recoveryAttribution` naming the approved retry.
8. Deliver a success carrying a different payment id and confirm recovered revenue does not change.
9. Store the date, account capability, sanitized request and response shapes, webhook event ids, and
   command results in this document.
10. Only then set `RAZORPAY_RECURRING_RETRY_ENABLED=true`, and only on a non-public Test Mode
    integration app. The public demo keeps simulator payments and the proven fallback-link path.

**Current state: not completed; recurring retry is disabled.** Step 1 was attempted and failed —
see [Empirical result](#empirical-result-card-mandate-registration-is-refused-on-this-account-2026-08-28).
Steps 2 onward cannot proceed until Razorpay enables recurring card payments on this account. Nothing
in this repository should be read as evidence that a recurring charge has succeeded.
