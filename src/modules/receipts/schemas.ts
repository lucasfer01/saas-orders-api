import { z } from 'zod';

export const ReceiptOrderIdParams = z.object({
  id: z.string().min(1),
});

export const ReceiptIdParams = z.object({
  id: z.string().min(1),
});

export const CreateReceiptBody = z.object({
  currency: z.string().default('USD').optional(),
});

export const ListReceiptsQuery = z.object({
  page: z.coerce.number().min(1).default(1).optional(),
  pageSize: z.coerce.number().min(1).max(100).default(20).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
