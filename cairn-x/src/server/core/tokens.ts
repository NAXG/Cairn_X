import { createHash } from "node:crypto";

/** 令牌入库前统一哈希：库中只存 sha256，不存明文。 */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
