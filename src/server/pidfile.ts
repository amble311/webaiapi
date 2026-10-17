/**
 * 服务 PID 文件 —— `webaiapi start` 写、`webaiapi stop` 读。
 *
 * ## 为什么要它（2026-10-16 用户要求「增加子命令 stop 用于停止后台启动的服务」）
 * 服务平时是**前台**跑的（Ctrl-C 即可），但一旦用 `&` / `nohup` 丢到后台，
 * 想停就只能 `ps` + `kill` 找 pid（还得小心别杀错）。写个 pid 文件后：
 *
 * ```
 * webaiapi stop           # 优雅停止（SIGTERM，最多等 15s）
 * webaiapi stop --force   # 还不停就 SIGKILL
 * ```
 *
 * ## 设计要点
 * - 位置 `~/.ai-api/webaiapi.pid`（和凭证/历史同处，**与 cwd 无关**），
 *   可用环境变量 `WEBAIAPI_PID_FILE` 覆盖 ✓；
 * - 只删**自己的** pid 文件，且 `stop` 会先核对「这个 pid 是不是我们的服务」
 *   （读 `/proc/<pid>/cmdline`，Linux 有效；拿不到则跳过核对）；
 * - 陈旧文件（进程已死）自动清理，不让 `stop` 卡在假 pid 上。
 *
 * ⚠️ 纯文件/进程原语，便于单测（不碰网络、不碰浏览器）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** PID 文件路径（`WEBAIAPI_PID_FILE` 优先，其次 `~/.ai-api/webaiapi.pid`）。 */
export function pidFilePath(override?: string): string {
  const explicit = override ?? process.env['WEBAIAPI_PID_FILE'];
  if (explicit && explicit.trim()) return explicit.trim();
  return join(homedir(), '.ai-api', 'webaiapi.pid');
}

/** 写入 pid（原子性不重要：内容就一个数字，`stop` 会校验进程是否活着）。 */
export function writePidFile(pid: number, file?: string): void {
  const target = pidFilePath(file);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${pid}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // 写不进去不影响服务运行（只是 stop 用不了）
  }
}

/** 读取 pid；文件不存在 / 内容不是正整数 → `null`。 */
export function readPidFile(file?: string): number | null {
  const target = pidFilePath(file);
  try {
    if (!existsSync(target)) return null;
    const raw = readFileSync(target, 'utf8').trim();
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 删除 pid 文件（不存在也算成功）。 */
export function removePidFile(file?: string): void {
  try {
    rmSync(pidFilePath(file), { force: true });
  } catch {
    // 忽略
  }
}

/**
 * 只删「内容就是自己 pid」的文件（幂等）。
 *
 * ⚠️ 为什么要这个：多个实例（例如换端口再起一个）共用同一个 pid 文件路径，
 * 若某个实例退出时无条件删文件，会把**还在跑的那个**的 pid 文件也删掉 →
 * 之后 `webaiapi stop` 就只能走「没有 pid 文件」的兜底路径了。
 */
export function removePidFileIfOwned(pid: number = process.pid, file?: string): void {
  try {
    if (readPidFile(file) !== pid) return;
  } catch {
    return;
  }
  removePidFile(file);
}

/**
 * 进程是否还活着（`kill(pid, 0)` 探测）。
 *
 * ⚠️ `EPERM` 也算活着（那个进程存在，只是不归我们管）。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * 读进程命令行（Linux 走 `/proc/<pid>/cmdline`；其它平台/无权限返回空串）。
 *
 * 用途：`stop` 杀之前确认「这个 pid 真的是我们的服务」，避免 pid 复用误杀。
 * 拿不到命令行时（空串）由调用方决定是否继续 —— 我们的策略是继续但提示。
 */
export function processCommandLine(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

/** 命令行看起来像我们的服务吗（`webaiapi` / `cli.ts start` / `server/app`）。 */
export function looksLikeOurService(cmdline: string): boolean {
  if (!cmdline) return false;
  return /webaiapi|cli\.ts\s+start|dist\/cli\.js\s+start/.test(cmdline);
}
