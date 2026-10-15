/**
 * 服务端基础原语：错误类型与时间戳。
 *
 * 这里刻意不放任何业务依赖，供 core 各模块直接共享，避免 services.ts 同时
 * 充当「基础库」与「业务聚合」而被 evidence / decide 反向引用，
 * 形成循环依赖。基础原语改动后其余模块可零成本引用。
 */

/** 统一的 API 错误：路由层据此转成对应的 HTTP 状态码。 */
export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export { utcnow } from "../../shared/time.js";
