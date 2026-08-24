export interface RuntimeConfig {
  readonly port: number;
  readonly databaseUrl?: string;
  readonly razorpayKeyId?: string;
  readonly razorpayKeySecret?: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawPort = environment.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`PORT must be an integer between 1 and 65535: ${rawPort}`);
  const databaseUrl = environment.DATABASE_URL?.trim() || undefined;
  const razorpayKeyId = environment.RAZORPAY_KEY_ID?.trim() || undefined;
  const razorpayKeySecret = environment.RAZORPAY_KEY_SECRET?.trim() || undefined;
  if ((razorpayKeyId === undefined) !== (razorpayKeySecret === undefined)) throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured together');
  return {
    port,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(razorpayKeyId === undefined ? {} : { razorpayKeyId }),
    ...(razorpayKeySecret === undefined ? {} : { razorpayKeySecret }),
  };
}
