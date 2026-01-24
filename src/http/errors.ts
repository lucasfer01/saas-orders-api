export type ApiErrorCode =
	| "BAD_REQUEST"
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "CONFLICT"
	| "VALIDATION_ERROR"
	| "RATE_LIMITED"
	| "INTERNAL_ERROR";

export class ApiError extends Error {
	constructor(
		public statusCode: number,
		public code: ApiErrorCode,
		message: string,
		public details?: unknown,
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

export const unauthorized = (message = "Unauthorized") =>
	new ApiError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "Forbidden") =>
	new ApiError(403, "FORBIDDEN", message);

export const validationError = (
	message = "Validation error",
	details?: unknown,
) => new ApiError(422, "VALIDATION_ERROR", message, details);

export const tooManyRequests = (
	message = "Too many requests",
	details?: unknown,
) => new ApiError(429, "RATE_LIMITED", message, details);
