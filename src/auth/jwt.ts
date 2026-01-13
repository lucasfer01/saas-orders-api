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
	return jwt.sign(payload, process.env.JWT_ACCESS_SECRET!, {
		expiresIn: `${ttlMin}m`,
	});
}

export function signRefreshToken(payload: RefreshPayload) {
	const ttlDays = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 14);
	return jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, {
		expiresIn: `${ttlDays}d`,
	});
}

export function verifyAccessToken(token: string) {
	return jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as AccessPayload;
}

export function verifyRefreshToken(token: string) {
	return jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as RefreshPayload;
}
