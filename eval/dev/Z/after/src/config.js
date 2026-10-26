export const config = {
  env: process.env.NODE_ENV ?? "development",
  paypal: {
    base: process.env.PAYPAL_BASE_URL ?? 'https://api-m.paypal.com',
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
  },
  db: { url: process.env.DATABASE_URL },
};
