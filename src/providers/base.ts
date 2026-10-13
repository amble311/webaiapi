/**
 * Provider 基类 —— `legacy-python/src/providers/base.py` 的 TypeScript 移植。
 *
 * 与原实现的差异：
 * - Python 用 `@dataclass`；TS 用 `interface`（结构类型，无需运行时构造）。
 * - `BaseProvider` 是 `abstract class`（Python 用 `ABC` + `@abstractmethod`）；
 *   TS 的抽象方法在**编译期**就能拦住漏实现，比 Python 的运行时 `TypeError` 更早。
 * - `chat_stream` 返回 `AsyncGenerator`（Python 的 `AsyncIterator`），
 *   这样调用方可以用 `for await`，并且 `chatStream()` 内部的 `finally` 一定执行
 *   —— 这是「锁必须释放」那条硬约束的语言级保障。
 */

/** 聊天请求。 */
export interface ChatRequest {
  /** 要发给网页端模型的文本（会话复用时可能只含增量）。 */
  message: string;
  model?: string;
  conversation_id?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /**
   * 附加上下文。路由层用到的键：
   * - `session_key`     —— 逻辑会话 ID（判断能否复用网页会话）
   * - `delta_message`   —— 只含新增消息（可增量发送）
   * - `full_message`    —— 完整提示词（换号/会话不一致时必须发它）
   * - `use_aux_page`    —— 要求本次对话走辅助页面（两轮策略的 reparse）
   */
  context?: Record<string, unknown>;
  /**
   * 整个 HTTP 请求的**绝对截止时间戳**（毫秒，`Date.now()` 口径）。
   *
   * 用于把「首轮对话 + 两轮策略 reparse」等多段往返的总耗时收敛在超时中间件
   * （300s）以内，避免客户端拿到 504 而完全看不到内容。
   */
  deadlineTs?: number;
}

/** 聊天响应（一个分片或一次错误）。 */
export interface ChatResponse {
  content?: string;
  model?: string;
  conversation_id?: string;
  usage?: Record<string, number>;
  metadata?: Record<string, unknown>;
  error?: string;
}

/** Provider 抽象基类。 */
export abstract class BaseProvider {
  /** 平台标识（如 `chatglm-browser`）。 */
  public readonly platform: string;

  /** 本 Provider 对外暴露的模型名清单。 */
  public models: string[] = [];

  constructor(platform: string) {
    this.platform = platform;
  }

  /** 非流式聊天。 */
  abstract chat(request: ChatRequest): Promise<ChatResponse>;

  /** 流式聊天（必须串行化，见各实现的 `finally`）。 */
  abstract chatStream(request: ChatRequest): AsyncGenerator<ChatResponse>;

  /** 创建新会话，返回会话 ID。 */
  abstract createConversation(): Promise<string>;

  /** 删除会话。 */
  abstract deleteConversation(conversationId: string): Promise<void>;

  /** 检查登录状态。 */
  abstract checkLoginStatus(): Promise<boolean>;

  /** 获取支持的模型列表。 */
  getModels(): string[] {
    return this.models;
  }

  /**
   * 本 Provider **当前**使用的账号 ID。
   *
   * 为什么要暴露：`ModelRouter` 必须知道「主通道现在占着哪个账号」，
   * 才能给辅助通道挑一个**不同的**账号（同账号并行会立刻触发
   * 「请等待其他对话生成完毕」）。Python 版是直接读 `provider._account_id`
   * 私有字段；TS 用显式方法，避免到处访问私有成员。
   *
   * ⚠️ 主通道被限流**换号后**返回值会变，调用方不能缓存它。
   */
  getAccountId(): string {
    return 'default';
  }

  /** 辅助通道标识（非空表示这是独立通道实例，不是主通道）。 */
  getChannelKey(): string | undefined {
    return undefined;
  }

  /** 标记「刚被使用过」（更新空闲计时）。*/
  async markUsed(): Promise<void> {
    // 默认空实现：只有需要空闲超时的 Provider 才关心
  }

  /** 是否支持指定模型。 */
  supportsModel(model: string): boolean {
    return this.models.includes(model);
  }
}
