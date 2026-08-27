export interface RuntimeConfig {
  readonly port: number;
  readonly databaseUrl?: string;
  readonly razorpayKeyId?: string;
  readonly razorpayKeySecret?: string;
  readonly razorpayWebhookSecret?: string;
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
  const razorpayKeyId = environment.RAZORPAY_KEY_ID?.trim() || undefined;
  const razorpayKeySecret = environment.RAZORPAY_KEY_SECRET?.trim() || undefined;
  if ((razorpayKeyId === undefined) !== (razorpayKeySecret === undefined)) throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured together');
  // Razorpay signs webhooks with the webhook secret, which is issued separately from the API key.
  const razorpayWebhookSecret = environment.RAZORPAY_WEBHOOK_SECRET?.trim() || undefined;
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
    ...(razorpayKeyId === undefined ? {} : { razorpayKeyId }),
    ...(razorpayKeySecret === undefined ? {} : { razorpayKeySecret }),
    ...(razorpayWebhookSecret === undefined ? {} : { razorpayWebhookSecret }),
    ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
    ...(anthropicModel === undefined ? {} : { anthropicModel }),
    ...(pinccApiKey === undefined ? {} : { pinccApiKey }),
    ...(pinccBaseUrl === undefined ? {} : { pinccBaseUrl }),
    ...(pinccModel === undefined ? {} : { pinccModel }),
    ...(diagnosisTimeoutMilliseconds === undefined ? {} : { diagnosisTimeoutMilliseconds }),
  };
}
