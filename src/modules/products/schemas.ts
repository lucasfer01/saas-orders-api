import { z } from "zod";

export const CreateProductBody = z.object({
	name: z.string().min(1).max(120),
	priceCents: z.number().int().min(0).max(1_000_000_000),
	active: z.boolean().optional(),
});

export const UpdateProductBody = z
	.object({
		name: z.string().min(1).max(120).optional(),
		priceCents: z.number().int().min(0).max(1_000_000_000).optional(),
		active: z.boolean().optional(),
	})
	.refine((v) => Object.keys(v).length > 0, {
		message: "Body must not be empty",
	});

export const ListProductsQuery = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	active: z
		.union([z.literal("true"), z.literal("false")])
		.optional()
		.transform((v) => (v === undefined ? undefined : v === "true")),
	search: z.string().trim().min(1).max(120).optional(),
});

export const ProductIdParams = z.object({
	id: z.string().min(1),
});
