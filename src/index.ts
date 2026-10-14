/**
 * `webaiapi` 库入口。
 *
 * 当前进度见 `docs/migration-status.md`。
 * 已可用的部分：配置层、类型层、工具调用协议层（M1）。
 */

export type { Settings, LoadSettingsOptions } from './config.js';
export {
  settings,
  loadSettings,
  toBool,
  toInt,
  parseDotEnv,
  expandHome,
  getAvailableModelsList,
  getApiKeys,
  getDefaultWorkspacePaths,
} from './config.js';

export type {
  ChatMessage,
  ContentPart,
  MessageContent,
  MessageDict,
  MessageRole,
  ToolCallPayload,
  ToolDefinition,
} from './types/message.js';
export {
  ALLOWED_ROLES,
  getTextContent,
  messageToDict,
  toolNameOf,
  toolParamNames,
  toolRequiredParams,
} from './types/message.js';

export type {
  ChatCompletionChoice,
  ChatCompletionRequest,
  HealthCheckResponse,
  ModelInfo,
  ModelListResponse,
  Usage,
} from './types/openai.js';
export {
  buildOpenAiError,
  chatCompletionRequestSchema,
  makeModelInfo,
  messageSchema,
  nowSeconds,
} from './types/openai.js';

export { logger, resolveLogLevel } from './log/logger.js';

/* ---------------- 工具调用协议层 ---------------- */

export { cleanDomHtml, normalizeToolCallTags, stripLeftoverToolTags } from './tools/clean.js';

export {
  PLACEHOLDER_PATH_KEYS,
  PLACEHOLDER_TOOL_NAMES,
  PLACEHOLDER_VALUES,
  filterPlaceholderToolCalls,
  isPlaceholderToolCall,
} from './tools/placeholder.js';

export {
  DOM_CORRUPTION_INDICATOR,
  DOM_PREVIEW_KEY_INDICATOR,
  escapeRegExp,
  extractComplexFieldFromCorrupted,
  extractPathFromCorrupted,
  extractToolCallByRegex,
  hasSmartQuotes,
  repairDomCorruptedJson,
  repairJson,
  tryParseJson,
} from './tools/repair.js';

export {
  EMPTY_TOOL_MAPS,
  FILE_SYSTEM_TOOLS,
  PLATFORM_BUILTIN_TOOL_NAMES,
  TOOL_NAME_ALIASES,
  TRAE_INTERNAL_TOOLS,
  USER_INTERACTION_TOOLS,
  createToolMaps,
  detectToolNames,
  filterUnknownToolCalls,
  makeToolCallId,
  normalizeParamKey,
  normalizeToolArguments,
  normalizeToolName,
  repairToolCallBySignature,
  resolveToolName,
} from './tools/names.js';
export type { SignatureReroute, ToolMaps } from './tools/names.js';

export { buildToolCall } from './tools/build.js';

export { parseToolCallsFromText, rawDecodeJson } from './tools/parse.js';
export type { ParseResult } from './tools/parse.js';

export {
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  TOOL_DESC_MAX_LEN,
  buildToolProtocol,
  formatMessagesAsText,
  formatToolsAsText,
} from './tools/protocol.js';
export type { FormatToolsOptions, ToolProtocol } from './tools/protocol.js';

export {
  FABRICATED_PATH_PREFIXES,
  PATH_LINE_PATTERN,
  SELF_PROJECT_DIR,
  WORKSPACE_PATH_PATTERNS,
  extractFilePathsFromMessages,
  extractWorkspacePath,
} from './tools/workspace.js';
export type { ExtractWorkspaceOptions } from './tools/workspace.js';

export {
  buildWriteArgs,
  collectFilePathsInText,
  convertTextToToolCalls,
  directConvertToToolCalls,
  inferFilename,
  looksLikeFileContent,
  looksLikeFilepath,
} from './tools/convert.js';

export { RECOVERY_ANSWER_MAX_LEN, buildActionRecoveryPrompt } from './tools/prompts.js';
export type { BuildActionRecoveryPromptOptions } from './tools/prompts.js';

/* ---------------- 浏览器层（M2） ---------------- */

export { Mutex } from './utils/mutex.js';
export { computeIncremental, sanitizeMessage, truncateMessage } from './utils/text.js';

export { SSE_CAPTURE_JS } from './browser/sse-capture.js';
export { STEALTH_JS } from './browser/stealth.js';

export {
  authBaseDir,
  authFilePath,
  cookieFingerprint,
  decodeJwt,
  getCookieValue,
  isAuthAvailable,
  legacyAuthFilePath,
  listAccounts,
  loadAuth,
  normalizeCookies,
} from './browser/credentials.js';
export type { AccountInfo, AuthRecord, CapturedCookie, PlatformApiPattern } from './browser/credentials.js';

/* 平台注册表（单一真相：加平台只改 `platforms.ts`） */
export {
  PLATFORMS,
  PLATFORM_API_PATTERNS,
  PLATFORM_IDS,
  PLATFORM_LIST,
  PLATFORM_LOGIN_URLS,
  PLATFORM_NAMES,
  PLATFORMS_WITH_PROVIDER,
  extractAccountInfoSync,
  isKnownPlatform,
  platformDisplayName,
} from './browser/platforms.js';
export type { PlatformSpec } from './browser/platforms.js';

export {
  accountCooldownRemaining,
  accountKey,
  browserState,
  clearAccountRole,
  closeBrowser,
  disposeAllChannels,
  disposeSharedBrowser,
  enterAccount,
  exitAccount,
  getAccountRole,
  getBrowser,
  getChannelPage,
  getPage,
  injectResponseJs,
  invalidateBrowser,
  isAccountBusy,
  isAccountCooling,
  loadCookies,
  markAccountCooldown,
  navigateTo,
  newWorkPage,
  peekPage,
  resetAccountState,
  setAccountRole,
  sweepOrphanBrowsers,
  transferAccountBusy,
  writeAuthFile,
} from './browser/manager.js';
export type { SharedBrowser } from './browser/manager.js';

/* ---------------- Provider 层（M3） ---------------- */

export { BaseProvider } from './providers/base.js';
export type { ChatRequest, ChatResponse } from './providers/base.js';

export {
  extractSseAll,
  extractSseAnswer,
  getLastRawSse,
  isBlankOrForeignUrl,
  isBrowserConnectionError,
  iterSseJson,
  logSseSummary,
  resetLastRawSse,
  safeIncremental,
  setLastRawSse,
} from './providers/chatglm-sse.js';
export type { LastRawSse, SseExtractResult } from './providers/chatglm-sse.js';

/* ---------------- 控制器层（M4） ---------------- */

export {
  ModelRouter,
  PLATFORM_MODEL_NAMES,
  PROVIDER_IMPLEMENTED_PLATFORMS,
  getModelRouter,
  __setModelRouterForTest,
} from './controllers/router.js';
export type { AccountSummaryItem, MixCandidate } from './controllers/router.js';

export { HistoryDB, getHistoryDb, defaultHistoryDbPath } from './controllers/history-db.js';
export type { HistoryMessage, HistoryStats } from './controllers/history-db.js';

export {
  IntelligentScheduler,
  RequestPool,
  getRequestPool,
  getScheduler,
} from './controllers/request-pool.js';
export type { PooledRequest, RequestPoolStatus, RequestStatus } from './controllers/request-pool.js';

/* ---------------- 日志（M4） ---------------- */

export {
  apiLogPath,
  formatTimestamp,
  logAiPlatformRequest,
  logAiPlatformResponse,
  logAiPlatformResponseComplete,
  logApiError,
  logApiRequest,
  logApiResponse,
  logRoundStart,
  resetApiLog,
} from './log/api-logger.js';

export {
  debugLogPath,
  logAiRequest,
  logAiResponse,
  logClientRequest,
  logClientResponse,
  logError,
  logToolCallResult,
} from './log/debug-logger.js';

/* ---------------- 路由辅助（M4） ---------------- */

export {
  BROWSER_PROMPT_MAX_LEN,
  COMPRESS_MIN_BUDGET,
  TOOL_ROUND_LIMIT,
  TOTAL_TIME_BUDGET,
  buildUsage,
  detectMismatchedAnswer,
  estimateTokens,
  extractUserQuestion,
  formatHistoryContext,
  formatRecentProgress,
  getSessionDelta,
  isReadOnlyTool,
  looksUnfinishedAnswer,
  platformOf,
  rememberSessionSend,
  truncatePromptForBrowser,
} from './routes/helpers.js';

export { buildReparseInput, extractPlatformName, streamWithFailover } from './routes/failover.js';
export {
  compressTextWithPage,
  precompressHistory,
  schedulePrecompress,
  shrinkPromptViaCompression,
  splitForCompression,
  summaryIsAbortable,
  summaryIsBad,
  waitForBackgroundTasks,
} from './routes/compress.js';
export { DONE, contentChunk, roleChunk, sseData, toolCallsChunk } from './routes/sse.js';
export {
  nonStreamChatCompletion,
  parseAndRecoverToolCalls,
  preparePrompt,
  registerChatRoutes,
  streamChatCompletion,
} from './routes/chat.js';
export type { PrepareResult, PreparedRequest } from './routes/chat.js';
export { registerMetaRoutes, runStartupTasks } from './routes/meta.js';

/* ---------------- 服务与 CLI（M4） ---------------- */

export { createApp, initApiKeys, startServer } from './server/app.js';
export { ApiKeyManager, extractApiKey, getApiKeyManager, verifyApiKey } from './server/middleware/api-key.js';
export { RateLimiter, TokenBucket, clientKeyOf } from './server/middleware/rate-limit.js';
export { makeTimeoutHook } from './server/middleware/timeout.js';
export { AuthCapture, capturePlatformAuth, fetchAccountInfo } from './browser/auth-capture.js';
export {
  deriveAccountId,
  detectDuplicate,
  readExistingAccounts,
  runLogin,
  runLogout,
  slugAccountId,
  toSlug,
} from './browser/login-flow.js';
export type {
  DuplicateVerdict,
  ExistingAccount,
  IdentityPrint,
  LoginOptions,
  LogoutOptions,
} from './browser/login-flow.js';

/* 交互式提问工具（菜单 / 输入 / 确认） */
export {
  confirmYesNo,
  displayWidth,
  firstSelectableIndex,
  inputText,
  isInteractive,
  padDisplay,
  renderChoiceList,
  resolveChoiceInput,
  selectOne,
  supportsColor,
  tokenizeKeys,
} from './utils/prompt.js';
export type { Choice, ChoiceResolution, KeyToken } from './utils/prompt.js';

export { helpText, parseArgs, runCli } from './cli.js';

export { ChatGLMBrowserProvider } from './providers/chatglm.js';
export type { ChatGLMProviderOptions } from './providers/chatglm.js';

export {
  DETECT_COMPLETION_JS,
  DETECT_THINKING_JS,
  HAS_INPUT_BOX_JS,
  PAGE_SHOWS_BUSY_JS,
  PROBE_LOGGED_IN_JS,
  READ_BUSY_NOTICE_JS,
  RESET_SSE_JS,
  SSE_GET_JS,
} from './providers/chatglm-dom.js';
export { EXTRACT_RESPONSE_JS, FORCED_EXTRACT_JS } from './providers/chatglm-dom-extract.js';
