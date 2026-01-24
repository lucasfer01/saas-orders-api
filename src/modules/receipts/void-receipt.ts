import type { Prisma, PrismaClient } from "@prisma/client";

export async function voidReceiptTransactional(
	prisma: Prisma.TransactionClient,
	tenantId: string,
	receiptId: string,
	reason: string,
	outboxPayload: object,
): Promise<unknown> {
	return (prisma as PrismaClient).$transaction(
		async (tx: Prisma.TransactionClient) => {
			const receipt = await tx.receipt.findFirst({
				where: { id: receiptId, tenantId },
				include: { items: true },
			});
			if (!receipt) throw new Error("RECEIPT_NOT_FOUND");
			if (receipt.status === "VOIDED") return receipt;

			const voided = await tx.receipt.update({
				where: { id: receiptId },
				data: {
					status: "VOIDED",
					voidedAt: new Date(),
					voidReason: reason,
				},
				include: { items: true },
			});

			await tx.outboxEvent.create({
				data: {
					tenantId,
					type: "RECEIPT_VOIDED",
					payloadJson: outboxPayload,
					status: "PENDING",
				},
			});

			return voided;
		},
	);
}
