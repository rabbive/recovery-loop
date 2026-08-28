export interface RuntimeConfig {
  readonly port: number;
  readonly databaseUrl?: string;
  /** Whether the instance must refuse to start rather than fall back to memory storage. */
  readonly requireDatabase: boolean;
  readonly razorpayKeyId?: string;
  readonly razorpayKeySecret?: string;
  readonly razorpayWebhookSecret?: string;
  /** Whether the unproven Razorpay recurring charge may reach the network. Off unless proven. */
  readonly razorpayRecurringRetryEnabled: boolean;
  /** Bearer token for the routes that change state. Absent means the control plane is disabled. */
  readonly controlPlaneToken?: string;
  /** HMAC secret the simulator verifies deliveries against. Absent means a fresh per-process secret. */
  readonly simulatorWebhookSecret?: string;
  readonly anthropicApiKey?: string;
  readonly anthropicModel?: string;
  readonly pinccApiKey?: string;
  readonly pinccBaseUrl?: string;
  readonly pinccModel?: string;
  readonly diagnosisTimeoutMilliseconds?: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawPort = environment.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`PORT must be an integer between 1 and 65535: ${rawPort}`);
  const databaseUrl = environment.DATABASE_URL?.trim() || undefined;
  // Memory storage is the right default for a local run and the wrong one for a deployment: an
  // instance that silently loses every case and audit record on restart looks healthy while doing
  // it. A public deployment sets this, and then a missing database is a startup failure.
  const rawRequireDatabase = environment.REQUIRE_DATABASE?.trim() || undefined;
  if (rawRequireDatabase !== undefined && rawRequireDatabase !== 'true' && rawRequireDatabase !== 'false') {
    throw new Error(`REQUIRE_DATABASE must be true or false: ${rawRequireDatabase}`);
  }
  const requireDatabase = rawRequireDatabase === 'true';
  if (requireDatabase && databaseUrl === undefined) throw new Error('REQUIRE_DATABASE=true requires DATABASE_URL');
  const razorpayKeyId = environment.RAZORPAY_KEY_ID?.trim() || undefined;
  const razorpayKeySecret = environment.RAZORPAY_KEY_SECRET?.trim() || undefined;
  if ((razorpayKeyId === undefined) !== (razorpayKeySecret === undefined)) throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured together');
  // Razorpay signs webhooks with the webhook secret, which is issued separately from the API key.
  // Substituting the API secret would mean one leaked value both calls the API and forges events.
  const razorpayWebhookSecret = environment.RAZORPAY_WEBHOOK_SECRET?.trim() || undefined;
  if (razorpayKeySecret !== undefined && razorpayWebhookSecret === undefined) throw new Error('RAZORPAY_WEBHOOK_SECRET must be configured alongside the Razorpay API credentials');
  // Only the exact string enables it, so a typo reads as off rather than silently arming a charge.
  const rawRecurringRetry = environment.RAZORPAY_RECURRING_RETRY_ENABLED?.trim() || undefined;
  if (rawRecurringRetry !== undefined && rawRecurringRetry !== 'true' && rawRecurringRetry !== 'false') {
    throw new Error(`RAZORPAY_RECURRING_RETRY_ENABLED must be true or false: ${rawRecurringRetry}`);
  }
  const razorpayRecurringRetryEnabled = rawRecurringRetry === 'true';
  const controlPlaneToken = environment.CONTROL_PLANE_TOKEN?.trim() || undefined;
  const simulatorWebhookSecret = environment.SIMULATOR_WEBHOOK_SECRET?.trim() || undefined;
  const anthropicApiKey = environment.ANTHROPIC_API_KEY?.trim() || undefined;
  const anthropicModel = environment.ANTHROPIC_MODEL?.trim() || undefined;
  const pinccApiKey = environment.PINCC_API_KEY?.trim() || undefined;
  const pinccModel = environment.PINCC_MODEL?.trim() || undefined;
  if ((pinccApiKey === undefined) !== (pinccModel === undefined)) throw new Error('PINCC_API_KEY and PINCC_MODEL must be configured together');
  const rawPinccBaseUrl = environment.PINCC_BASE_URL?.trim() || undefined;
  const pinccBaseUrl = rawPinccBaseUrl?.replace(/\/+$/, '');
  if (pinccBaseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(pinccBaseUrl);
    } catch {
      throw new Error(`PINCC_BASE_URL must be a valid HTTPS URL: ${rawPinccBaseUrl}`);
    }
    if (parsed.protocol !== 'https:') throw new Error(`PINCC_BASE_URL must be a valid HTTPS URL: ${rawPinccBaseUrl}`);
  }
  const rawTimeout = environment.DIAGNOSIS_TIMEOUT_MS?.trim() || undefined;
  let diagnosisTimeoutMilliseconds: number | undefined;
  if (rawTimeout !== undefined) {
    diagnosisTimeoutMilliseconds = Number(rawTimeout);
    if (!Number.isInteger(diagnosisTimeoutMilliseconds) || diagnosisTimeoutMilliseconds < 1) throw new Error(`DIAGNOSIS_TIMEOUT_MS must be a positive integer: ${rawTimeout}`);
  }
  return {
    port,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    requireDatabase,
    ...(razorpayKeyId === undefined ? {} : { razorpayKeyId }),
    ...(razorpayKeySecret === undefined ? {} : { razorpayKeySecret }),
    ...(razorpayWebhookSecret === undefined ? {} : { razorpayWebhookSecret }),
    razorpayRecurringRetryEnabled,
    ...(controlPlaneToken === undefined ? {} : { controlPlaneToken }),
    ...(simulatorWebhookSecret === undefined ? {} : { simulatorWebhookSecret }),
    ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
    ...(anthropicModel === undefined ? {} : { anthropicModel }),
    ...(pinccApiKey === undefined ? {} : { pinccApiKey }),
    ...(pinccBaseUrl === undefined ? {} : { pinccBaseUrl }),
    ...(pinccModel === undefined ? {} : { pinccModel }),
    ...(diagnosisTimeoutMilliseconds === undefined ? {} : { diagnosisTimeoutMilliseconds }),
  };
}
