export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_SERVER_ERROR";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: ApiErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "BAD_REQUEST", message, details);

export const notFound = (message = "Resource not found") =>
  new ApiError(404, "NOT_FOUND", message);

export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, "CONFLICT", message, details);
