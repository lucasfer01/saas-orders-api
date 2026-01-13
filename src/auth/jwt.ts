import jwt from "jsonwebtoken";

type AccessPayload = {
	sub: string; // userId
	tenantId: string;
	roles: string[];
};

type RefreshPayload = {
	sub: string; // userId
	tenantId: string;
	tokenId: string; // refreshToken db id
};

export function signAccessToken(payload: AccessPayload) {
	const ttlMin = Number(process.env.JWT_ACCESS_TTL_MIN ?? 15);
	const secret = process.env.JWT_ACCESS_SECRET;
	if (!secret) {
		throw new Error("Missing JWT_ACCESS_SECRET in environment");
	}
	return jwt.sign(payload, secret, {
		expiresIn: `${ttlMin}m`,
	});
}

export function signRefreshToken(payload: RefreshPayload) {
	const ttlDays = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 14);
	const secret = process.env.JWT_REFRESH_SECRET;
	if (!secret) {
		throw new Error("Missing JWT_REFRESH_SECRET in environment");
	}
	return jwt.sign(payload, secret, {
		expiresIn: `${ttlDays}d`,
	});
}

export function verifyAccessToken(token: string) {
	const secret = process.env.JWT_ACCESS_SECRET;
	if (!secret) {
		throw new Error("Missing JWT_ACCESS_SECRET in environment");
	}
	return jwt.verify(token, secret) as AccessPayload;
}

export function verifyRefreshToken(token: string) {
	const secret = process.env.JWT_REFRESH_SECRET;
	if (!secret) {
		throw new Error("Missing JWT_REFRESH_SECRET in environment");
	}
	return jwt.verify(token, secret) as RefreshPayload;
}
