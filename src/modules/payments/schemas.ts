import { z } from "zod";

export const PaymentParams = z.object({
  id: z.string().min(1), // order id
});

export const CreatePaymentBody = z.object({
  amountCents: z.number().int().min(1),
  method: z.enum(["CASH", "CARD", "TRANSFER", "OTHER"]),
  idempotencyKey: z.string().min(10).max(200),
  // Solo para tests (permitir forzar falla)
  testFail: z.boolean().optional(),
});
