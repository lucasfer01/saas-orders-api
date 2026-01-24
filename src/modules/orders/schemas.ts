import { z } from "zod";

export const CreateOrderBody = z.object({});

export const ListOrdersQuery = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	status: z
		.enum(["DRAFT", "OPEN", "PAID", "CANCELED"]) // OrderStatus
		.optional(),
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional(),
});

export const OrderIdParams = z.object({
	id: z.string().min(1),
});

export const AddItemBody = z.object({
	productId: z.string().min(1),
	qty: z.number().int().min(1).max(1_000),
});

export const UpdateOrderStatusBody = z.object({
	toStatus: z.enum(["DRAFT", "OPEN", "PAID", "CANCELED"]),
});

export const OrderItemIdParams = z.object({
	id: z.string().min(1),
	itemId: z.string().min(1),
});

export const UpdateItemBody = z.object({
	qty: z.number().int().min(1).max(1_000),
});
