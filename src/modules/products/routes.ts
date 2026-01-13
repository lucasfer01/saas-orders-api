import type { FastifyPluginAsync } from "fastify";
import { requireTenantId } from "../../http/tenant.js";
import { badRequest, notFound } from "../../http/errors.js";
import { CreateProductBody, ListProductsQuery, ProductIdParams, UpdateProductBody } from "./schemas.js";

export const productsRoutes: FastifyPluginAsync = async (app) => {
  // POST /products
  app.post("/products", async (req, reply) => {
    const tenantId = requireTenantId(req.headers as Record<string, unknown>);
    const body = CreateProductBody.parse(req.body);

    const product = await app.prisma.product.create({
      data: {
        tenantId,
        name: body.name,
        priceCents: body.priceCents,
        active: body.active ?? true,
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        priceCents: true,
        active: true,
        createdAt: true,
      },
    });

    return reply.status(201).send(product);
  });

  // GET /products?page=&pageSize=&active=&search=
  app.get("/products", async (req) => {
    const tenantId = requireTenantId(req.headers as Record<string, unknown>);
    const q = ListProductsQuery.parse(req.query);

    const where = {
      tenantId,
      ...(q.active !== undefined ? { active: q.active } : {}),
      ...(q.search
        ? {
            name: {
              contains: q.search,
              mode: "insensitive" as const,
            },
          }
        : {}),
    };

    const skip = (q.page - 1) * q.pageSize;
    const take = q.pageSize;

    const [items, total] = await Promise.all([
      app.prisma.product.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          tenantId: true,
          name: true,
          priceCents: true,
          active: true,
          createdAt: true,
        },
      }),
      app.prisma.product.count({ where }),
    ]);

    return {
      page: q.page,
      pageSize: q.pageSize,
      total,
      items,
    };
  });

  // PATCH /products/:id
  app.patch("/products/:id", async (req) => {
    const tenantId = requireTenantId(req.headers as Record<string, unknown>);
    const { id } = ProductIdParams.parse(req.params);
    const body = UpdateProductBody.parse(req.body);

    const existing = await app.prisma.product.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw notFound("Product not found");

    try {
      const updated = await app.prisma.product.update({
        where: { id },
        data: body,
        select: {
          id: true,
          tenantId: true,
          name: true,
          priceCents: true,
          active: true,
          createdAt: true,
        },
      });
      return updated;
    } catch (e) {
      // En este endpoint no debería pasar mucho, pero queda un ejemplo de error controlado
      throw badRequest("Could not update product", { cause: String(e) });
    }
  });

  // GET /products/:id
  app.get("/products/:id", async (req) => {
    const tenantId = requireTenantId(req.headers as Record<string, unknown>);
    const { id } = ProductIdParams.parse(req.params);

    const product = await app.prisma.product.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        tenantId: true,
        name: true,
        priceCents: true,
        active: true,
        createdAt: true,
      },
    });

    if (!product) throw notFound("Product not found");
    return product;
  });
};
