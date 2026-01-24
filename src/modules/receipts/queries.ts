// Helpers y queries para el módulo receipts
// Todas las queries deben ser tenant-scoped y sin uso de any


import { PrismaClient } from '@prisma/client';

export async function findReceiptByOrderId(prisma: PrismaClient, tenantId: string, orderId: string) {
  return prisma.receipt.findUnique({
    where: {
      orderId,
      tenantId,
    },
    include: { items: true },
  });
}

export async function findReceiptById(prisma: PrismaClient, tenantId: string, id: string) {
  return prisma.receipt.findFirst({
    where: {
      id,
      tenantId,
    },
    include: { items: true },
  });
}

export async function listReceipts(
  prisma: PrismaClient,
  tenantId: string,
  { page = 1, pageSize = 20, from, to }: { page?: number; pageSize?: number; from?: Date; to?: Date }
) {
  const where = {
    tenantId,
    ...(from || to ? { issuedAt: { gte: from, lte: to } } : {}),
  };
  const [total, items] = await prisma.$transaction([
    prisma.receipt.count({ where }),
    prisma.receipt.findMany({
      where,
      orderBy: { issuedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { items: true },
    }),
  ]);
  return { total, items, page, pageSize };
}

export async function getNextReceiptNumber(prisma: PrismaClient, tenantId: string) {
  const key = 'RECEIPT';
  const updated = await prisma.tenantCounter.upsert({
    where: { tenantId_key: { tenantId, key } },
    update: { value: { increment: 1 } },
    create: { tenantId, key, value: 1 },
  });
  return updated.value;
}


export async function createReceiptTransactional(
  prisma: PrismaClient,
  tenantId: string,
  orderId: string,
  currency: string,
  orderSnapshot: {
    subtotalCents: number;
    totalCents: number;
    items: Array<{ productId?: string; name: string; unitPriceCents: number; qty: number; lineTotalCents: number }>;
  },
  outboxPayload: object
) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, tenantId, status: 'PAID' },
      include: { items: true },
    });
    if (!order) throw new Error('ORDER_NOT_FOUND_OR_NOT_PAID');
    const existing = await tx.receipt.findUnique({ where: { orderId } });
    if (existing) return existing;
    const number = await getNextReceiptNumber(tx as PrismaClient, tenantId);
    const receipt = await tx.receipt.create({
      data: {
        tenantId,
        orderId,
        number,
        status: 'ISSUED',
        currency,
        subtotalCents: orderSnapshot.subtotalCents,
        taxCents: 0,
        totalCents: orderSnapshot.totalCents,
        items: {
          create: orderSnapshot.items.map((item) => ({
            tenantId,
            productId: item.productId,
            name: item.name,
            unitPriceCents: item.unitPriceCents,
            qty: item.qty,
            lineTotalCents: item.lineTotalCents,
          })),
        },
      },
      include: { items: true },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId,
        type: 'RECEIPT_ISSUED',
        payloadJson: outboxPayload as any,
        status: 'PENDING',
      },
    });
    return receipt;
  });
}
