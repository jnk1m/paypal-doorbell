import { z } from "zod";

// Shape of the PayPal events this app cares about. Unknown keys are dropped.
export const PayPalEventSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  create_time: z.string(),
  resource_type: z.string().optional(),
  resource: z.object({
    id: z.string(),
    amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
    links: z.array(z.object({ href: z.string(), rel: z.string() })).default([]),
    supplementary_data: z.any().optional(),
  }),
});
