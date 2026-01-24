import { Prisma } from '@prisma/client';

export async function voidReceiptTransactional(
  prisma: Prisma.TransactionClient | any,
  tenantId: string,
  receiptId: string,
  reason: string,
  outboxPayload: object
) {
  return prisma.$transaction(async (tx: any) => {
    const receipt = await tx.receipt.findFirst({
      where: { id: receiptId, tenantId },
      include: { items: true },
    });
    if (!receipt) throw new Error('RECEIPT_NOT_FOUND');
    if (receipt.status === 'VOIDED') return receipt;

    const voided = await tx.receipt.update({
      where: { id: receiptId },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidReason: reason,
      },
      include: { items: true },
    });

    await tx.outboxEvent.create({
      data: {
        tenantId,
        type: 'RECEIPT_VOIDED',
        payloadJson: outboxPayload as any,
        status: 'PENDING',
      },
    });

    return voided;
  });
}
