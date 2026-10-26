PayPal webhook (production)
- Registered under REST app "shop-prod" (client id starts AYk3...), live environment
- URL: https://shop.example.com/api/paypal/webhook
- Events: PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.REFUNDED, PAYMENT.CAPTURE.DENIED
- Webhook ID is stored in PAYPAL_WEBHOOK_ID
- Orders are created by src/payments/checkout.js with PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET
