import { z } from "zod";

// Params para rutas por Order
export const OrderIdParams = z.object({
	id: z.string().min(1),
});

// Params para rutas por Payment
export const PaymentIdParams = z.object({
	paymentId: z.string().min(1),
});

export const CreatePaymentBody = z.object({
	amountCents: z.number().int().min(1),
	// Métodos permitidos en v1
	method: z.enum(["CASH", "CARD", "TRANSFER"]),
	idempotencyKey: z.string().min(10).max(200),
	// Solo para tests (permitir forzar falla)
	testFail: z.boolean().optional(),
});

// Query opcional para listado (simple v1)
export const ListPaymentsQuery = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
