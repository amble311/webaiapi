/**
 * 交互式登录 / 退出编排（`webaiapi login` / `webaiapi logout`）。
 *
 * ## 与 `auth-capture.ts` 的分工
 * - `auth-capture.ts` —— **机制**：开浏览器、抓 cookie/bearer、原子落盘。它不知道
 *   「用户是谁、想存成哪个账号」。
 * - 本文件 —— **编排**：问用户选平台/账号、决定账号名、去重、汇报结果。
 *
 * ## 它解决的两个真问题
 *
 * ### 1. 多账号「怎么命名」
 * 旧流程要求用户**自己**想账号名（`webaiapi login chatglm --account acc2`），
 * 于是出现了大量 `acc2` / `test` / `a` 这种名字 —— 过两周没人记得谁是谁。
 * 现在：捕获完直接**用平台返回的身份**（用户名）派生账号名，
 * 用户只需在确有歧义时确认一下。
 *
 * ### 2. 「以为是两个账号，其实是同一个人」（最贵的坑）
 * 系统 Firefox 常带着**上一个账号**的登录态，于是第二次登录抓到的还是同一个人。
 * 旧流程只在文案里提醒「请先退出登录」，实际不校验 —— 而后果很实在：
 * `ModelRouter` 会把它们当成两个账号启用「辅助通道并行」，
 * 然后主对话和压缩请求打同一个账号，**立刻**收到
 * 「请等待其他对话生成完毕」，整个请求作废。
 *
 * 现在：捕获后**硬校验** Cookie 指纹与身份，把结论摆给用户：
 * - 指纹完全一致 → 「这和账号 X 是同一个登录态」（可选覆盖 X / 另存新账号）
 * - 身份一致但指纹不同 → 「同一个人重新登录」（建议直接更新 X）
 */
import { existsSync, rmSync } from 'node:fs';

import { AuthCapture, LoginCancelledError } from './auth-capture.js';
import {
  authFilePath,
  cookieFingerprint,
  listAccounts,
  loadAuth,
} from './credentials.js';
import {
  extractAccountInfoSync,
  PLATFORMS,
  PLATFORM_LIST,
  platformDisplayName,
  type PlatformSpec,
} from './platforms.js';
import { logger } from '../log/logger.js';
import { identityStrength } from './platforms.js';
import {
  bold,
  confirmYesNo,
  cyan,
  dim,
  isInteractive,
  selectOne,
  type Choice,
} from '../utils/prompt.js';

/* ==================================================================== */
/* 身份指纹（纯逻辑，可单测）                                            */
/* ==================================================================== */

/** 判断「是不是同一个人 / 同一个登录态」所需的最小信息集。 */
export interface IdentityPrint {
  /** 平台内的稳定身份标识（`extractAccountInfoSync` 的 `identifier`）。 */
  identity: string;
  /** 人类可读标签（用户名 / 邮箱）。 */
  label: string;
  /** Cookie 指纹（{@link cookieFingerprint}）。 */
  fingerprint: string;
  /** Cookie 数量（用来判断指纹是不是「空集指纹」）。 */
  cookies: number;
}

/** 磁盘上已有的账号。 */
export interface ExistingAccount extends IdentityPrint {
  id: string;
  capturedAt: number;
}

/** 对「新捕获的凭证」与「已有账号」关系的判定。 */
export type DuplicateVerdict =
  /** 全新账号。 */
  | { kind: 'fresh' }
  /** Cookie 完全一致 —— **同一个登录态**（同一个人的同一份会话）。 */
  | { kind: 'same-session'; accountId: string }
  /** 身份一致但 Cookie 不同 —— **同一个人重新登录**（如 cookie 过期后重登）。 */
  | { kind: 'same-identity'; accountId: string };

/**
 * 判断新捕获的凭证和已有账号是不是同一个人。
 *
 * 判定顺序（**先指纹后身份**，强度递减）：
 * 1. Cookie 指纹完全相同 → `same-session`。这比身份更硬：身份标识可能因为
 *    平台改字段而提取不到，但 Cookie 值对了就是同一份会话。
 * 2. 身份标识（`identifier`）相同 → `same-identity`。同一个人换了会话
 *    （重登、cookie 轮换）。
 *
 * ⚠️ `identity` 是 `'unknown'` 时**不算匹配**：兜底值对所有提取失败的平台都一样，
 * 拿它比对会把两个毫不相干的账号判成同一个人，反而制造出「并行打同一个账号」
 * 那个它本该防止的问题。
 *
 * ⚠️ 指纹比对要求 `cookies > 0`：空 Cookie 列表的指纹是个常量，
 * 两个「没抓到 cookie」的凭证会互相匹配。
 */
export function detectDuplicate(
  captured: IdentityPrint,
  existing: ReadonlyArray<ExistingAccount>,
): DuplicateVerdict {
  if (captured.cookies > 0) {
    const sameSession = existing.find(
      (acc) => acc.cookies > 0 && acc.fingerprint === captured.fingerprint,
    );
    if (sameSession) return { kind: 'same-session', accountId: sameSession.id };
  }

  const identity = captured.identity.trim();
  if (identity && identity !== 'unknown') {
    const samePerson = existing.find((acc) => acc.identity.trim() === identity);
    if (samePerson) return { kind: 'same-identity', accountId: samePerson.id };
  }

  return { kind: 'fresh' };
}

/**
 * 把任意字符串（用户名 / uid / 用户输入）洗成能当文件名的形式。
 *
 * 规则：非 `[A-Za-z0-9._-]` 的字符全部折成 `-`，合并连续分隔符、去掉首尾分隔符、
 * 转小写、截断到 32 字符。
 *
 * ⚠️ 洗不出东西时返回**空串**（而不是兜底成某个词）：中文用户名就属于这种，
 * 调用方需要知道「这个候选废了」才能退到下一个候选（见 {@link deriveAccountId}）。
 *
 * ⚠️ 返回值一定满足 `^[A-Za-z0-9._-]*$` 且不含 `/` —— 账号 ID 会被当作文件名
 * 拼接，这是防路径穿越的第一道闸（`AuthCapture.saveAs` 还有第二道硬校验）。
 */
export function toSlug(raw: string): string {
  return (raw || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .slice(0, 32)
    .replace(/[-._]+$/, '')
    .toLowerCase();
}

/**
 * 洗成**唯一**的账号 ID，可直接当文件名。
 *
 * ⚠️ **必须去重**：`existing` 里已有的名字要避开（`alice` → `alice-2`）。
 * 否则第二次登录同一个平台会把第一个账号的文件**原地覆盖**。
 */
export function slugAccountId(raw: string, existing: readonly string[] = []): string {
  const cleaned = toSlug(raw);
  const safe = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'account' : cleaned;

  const taken = new Set(existing);
  if (!taken.has(safe)) return safe;

  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${safe.slice(0, 28)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${safe.slice(0, 24)}-${Date.now()}`;
}

/**
 * 按优先级给账号挑一个名字。
 *
 * 顺序：用户显式给的 → 身份标签（用户名）→ 身份标识（uid）→ `account`。
 * 逐个尝试而不是只用第一个，是因为中文用户名洗完是空串，
 * 那时应该退到 uid，而不是直接落到无意义的 `account`。
 */
export function deriveAccountId(
  candidates: ReadonlyArray<string | undefined>,
  existing: readonly string[] = [],
): string {
  const picked = candidates.map((c) => toSlug(c ?? '')).find((slug) => slug !== '') ?? '';
  return slugAccountId(picked, existing);
}

/* ==================================================================== */
/* 磁盘读取                                                            */
/* ==================================================================== */

/**
 * 读出某平台已有的全部账号（含身份与指纹）。
 *
 * ⚠️ **只返回「能用的」账号**：`loadAuth` 会挡掉没有 cookie 或 JSON 损坏的文件，
 * 而那些文件不应该参与「这是不是同一个人」的判断（它们根本没会话可比）。
 * 需要**列出全部文件**（用来删除）请用 `listAccounts`。
 *
 * @param authDir 凭证目录（默认 `settings.authDir`，测试时传临时目录）
 */
export function readExistingAccounts(platform: string, authDir?: string): ExistingAccount[] {
  const out: ExistingAccount[] = [];

  for (const id of listAccounts(platform, authDir)) {
    const auth = loadAuth(platform, { accountId: id, authDir });
    if (!auth) continue;

    const info = extractAccountInfoSync(platform, auth);
    const cookies = auth.cookies ?? [];
    out.push({
      id,
      identity: info['identifier'] ?? '',
      label: info['label'] ?? '',
      fingerprint: cookieFingerprint(cookies),
      cookies: cookies.length,
      capturedAt: auth.captured_at ?? 0,
    });
  }

  return out;
}

/** 已经存在的账号总数（含各平台，用于全局提示）。 */
function totalAccountCount(): number {
  return PLATFORM_LIST.reduce((sum, spec) => sum + listAccounts(spec.id).length, 0);
}

/* ==================================================================== */
/* 菜单构造                                                            */
/* ==================================================================== */

/** 平台选项：带账号数与「能否对话」的提示。 */
function platformChoices(options: { onlyWithAccounts?: boolean } = {}): Choice<string>[] {
  const choices: Choice<string>[] = [];

  for (const spec of PLATFORM_LIST) {
    const count = listAccounts(spec.id).length;
    if (options.onlyWithAccounts && count === 0) continue;

    const hints = [count > 0 ? `${count} 个账号` : '尚未登录'];
    // 未实现 Provider 的平台**照样列出来**（这是「预留」对用户的可见形式），
    // 但明确标注，避免用户以为登录完就能用。
    if (!spec.providerImplemented) hints.push('暂不能对话');

    choices.push({ value: spec.id, label: spec.displayName, hint: hints.join(' · ') });
  }

  return choices;
}

/**
 * `login` 的动作菜单（纯函数，可单测）。
 *
 * ⚠️ 最后一项是**导航项**（`Symbol`），不是账号 ID —— 抽成纯函数就是为了让
 * 「`canGoBack` 时给返回、否则给取消」这条规则能被测试钉住：它是唯一
 * 决定「用户能不能退回去」的地方，改了没有任何别的东西会报错。
 *
 * @param canGoBack 平台是**从菜单选的**才为 true（命令行给的平台没有上一步）
 */
export function buildLoginActionChoices(
  existing: ReadonlyArray<ExistingAccount>,
  options: { canGoBack: boolean },
): Choice<string | NavChoice>[] {
  return [
    {
      value: '__new__',
      label: '➕ 添加新账号',
      hint: existing.length > 0 ? '登录另一个账号（完成后按身份自动命名）' : '（首次登录）',
    },
    ...existing.map((acc) => ({
      value: acc.id,
      label: `♻️  重新登录 ${acc.id}`,
      hint: `${acc.label} · ${acc.cookies} 个 cookie（cookie 过期时用这个刷新）`,
    })),
    options.canGoBack
      ? { value: BACK, label: '← 返回上一步（重新选平台）' }
      : { value: ABORT, label: '✗ 取消', hint: '等同按 Esc' },
  ];
}

/** 交互式确认；`yes` 直接通过，非交互且未给 `yes` 时返回 null（无法确认）。 */
async function confirmOrSkip(
  message: string,
  interactive: boolean,
  yes: boolean,
): Promise<boolean | null> {
  if (yes) return true;
  if (!interactive) return null;
  return confirmYesNo({ message, defaultYes: true });
}

/* ==================================================================== */
/* login                                                               */
/* ==================================================================== */

export interface LoginOptions {
  /** `webaiapi login <platform>`；缺省时交互选择。 */
  platform?: string;
  /** `--account <id>`：跳过「存成哪个账号」的询问。 */
  account?: string;
  /** `--yes`：所有确认直接通过（脚本用）。 */
  yes?: boolean;
  /** `--no-input`：即使有 TTY 也走非交互路径。 */
  noInput?: boolean;
}

/** 用户主动取消（Esc / Ctrl+C / EOF）的退出码（shell 惯例 128+SIGINT）。 */
const EXIT_CANCELLED = 130;

/**
 * 菜单里的「返回上一步」哨兵。
 *
 * ⚠️ 用 `Symbol` 而不是 `'__back__'` 这类字符串：菜单选项的值里混着
 * **真实账号 ID**，总有一天会和某个账号名撞上 —— 而且不会报错，
 * 只表现为「选那个账号时莫名回到了上一步」。
 */
const BACK = Symbol('back');

/** 菜单里的「退出 / 取消」哨兵（与 {@link BACK} 区分：一个是回上一步，一个是结束）。 */
const ABORT = Symbol('abort');

/** 导航选项的类型。 */
type NavChoice = typeof BACK | typeof ABORT;

/**
 * `webaiapi login` 的完整流程。
 *
 * ## 导航模型
 * 交互式登录是**两级**的（选平台 → 选动作），所以用一个小循环 + 显式哨兵
 * 而不是一串顺序执行的 `if`：
 *
 * ```
 *   平台菜单 ──选平台──▶ 动作菜单 ──选动作──▶ 开始捕获
 *      ▲                    │
 *      └──── 「← 返回上一步」─┘
 * ```
 *
 * ⚠️ **只从平台菜单进来的才有「上一步」**：`webaiapi login chatglm` 是用户在命令行
 * 明确指定的平台，没有可返回的地方，那里给的是「✗ 取消」。
 *
 * ⚠️ 动作菜单**即使 0 个账号也照样显示**（此时只有「添加新账号」+ 返回/取消）。
 * 看起来多按一次回车，换来的是「开了浏览器才发现平台选错」时还能退出来
 * —— 浏览器一旦启动就得等它登录完或 Ctrl+C。
 *
 * @returns 退出码：0 成功 / 1 失败 / 130 用户取消
 */
export async function runLogin(options: LoginOptions = {}): Promise<number> {
  const interactive = isInteractive() && !options.noInput;
  /** 平台来自命令行 → 没有「上一步」可返回。 */
  const platformFromCli = options.platform;

  let platform = platformFromCli ?? '';

  for (;;) {
    /* ---------------- 1. 选定平台 ---------------- */
    if (!platform) {
      if (!interactive) {
        console.error(
          '非交互环境必须指定平台：webaiapi login <platform>\n' +
            `可用平台: ${PLATFORM_LIST.map((s) => s.id).join(', ')}`,
        );
        return 1;
      }

      // 平台菜单里不会出现 BACK（没有上一步）→ 类型只放宽到 ABORT，
      // 这样 `picked === ABORT` 之后 TS 就能收窄成 string
      const picked = await selectOne<string | typeof ABORT>({
        message: '要登录哪个平台？',
        choices: [...platformChoices(), { value: ABORT, label: '✗ 退出', hint: '等同按 Esc' }],
      });
      if (picked === null || picked === ABORT) return EXIT_CANCELLED;
      platform = picked;
    }

    const spec = PLATFORMS[platform];
    if (!spec) {
      console.error(
        `未知平台: ${platform}\n可用平台: ${PLATFORM_LIST.map((s) => s.id).join(', ')}`,
      );
      return 1;
    }

    /* ---------------- 2. 未实现对话的平台：先说清楚 ---------------- */
    if (!spec.providerImplemented) {
      console.log(
        `\n⚠️  ${platformDisplayName(platform)} 尚未实现对话能力：` +
          '捕获到的凭证现在还用不上，\n' +
          '   只是先存下来（将来 Provider 就绪后可直接复用，无需重新登录）。',
      );
      const proceed = await confirmOrSkip(
        '仍然要捕获它的凭证吗？',
        interactive,
        options.yes ?? false,
      );

      if (proceed !== true) {
        if (proceed === null) {
          console.error('非交互环境下不继续（需要 --yes 才确认）。');
          return 1;
        }
        // 用户不想捕获 → 回平台菜单（他大概是想换个平台），而不是直接退出
        if (!platformFromCli) {
          platform = '';
          continue;
        }
        console.log('已取消。');
        return EXIT_CANCELLED;
      }
    }

    /* ---------------- 3. 决定这次写进哪个账号 ---------------- */
    const existing = readExistingAccounts(platform);
    let targetAccountId: string | null = options.account ?? null;

    if (targetAccountId === null && interactive) {
      const action = await selectOne({
        message:
          existing.length > 0
            ? `${spec.displayName} 已登录 ${existing.length} 个账号，这次要做什么？`
            : `${spec.displayName} 还没有账号，开始登录？`,
        choices: buildLoginActionChoices(existing, { canGoBack: !platformFromCli }),
      });

      if (action === null || action === ABORT) return EXIT_CANCELLED;
      if (action === BACK) {
        platform = '';
        continue;
      }
      targetAccountId = action === '__new__' ? null : action;
    }

    return loginOnPlatform({ platform, spec, existing, targetAccountId, options, interactive });
  }
}

/**
 * 在某个平台上真正走完一次登录：抓凭证 → 定账号名（含重复身份校验）→ 落盘 → 汇报。
 *
 * 从 {@link runLogin} 里拆出来，是因为「选平台/选动作」那部分变成了带导航的循环；
 * 这里则是**一条直路**（中间不再回头），两者混在一个函数里会让循环体长得没法读。
 */
async function loginOnPlatform(ctx: {
  platform: string;
  spec: PlatformSpec;
  existing: ExistingAccount[];
  targetAccountId: string | null;
  options: LoginOptions;
  interactive: boolean;
}): Promise<number> {
  const { platform, spec, existing, targetAccountId, options, interactive } = ctx;
  const existingIds = existing.map((acc) => acc.id);

  /* ---------------- 抓凭证 ---------------- */
  if (existing.length > 0 && targetAccountId === null) {
    console.log(
      `\n${bold('⚠️  请先在打开的浏览器里退出当前账号，再登录目标账号。')}\n` +
        '   否则抓到的还是上一个人 —— 抓完会打印身份给你核对。\n' +
        `   已有: ${existing.map((acc) => `${acc.id}(${acc.label})`).join(', ')}`,
    );
  }
  if (existing.length > 0) {
    console.log(
      `\n（当前浏览器里可能是上面的登录态。清不掉时，可在浏览器里开一个隐私窗口登录。）`,
    );
  }

  const capture = new AuthCapture(platform, {
    accountId: targetAccountId ?? '__pending__',
    headless: false,
    // 先不落盘：等拿到身份、定好账号名再写（见 AuthCaptureOptions.saveOnCapture）
    saveOnCapture: false,
    /* 捕获成功后**不立刻关浏览器**：先落盘 + 打印账号/身份，再由本函数调
     * `capture.finish()` 显示「已捕获登录凭证，请设置好模型参数后点击完成」，
     * 用户点「完成」才关窗（2026-10-16 用户要求）。
     * ⚠️ 因此本函数**每个早退分支都必须调 `capture.dispose()`**，否则会漏一个窗口。 */
    keepAlive: true,
    /* 选中的是**已有账号** → 先用保存的凭证试登录（有效就跳过登录，失效才给登录页）。 */
    reuseSavedCredential: Boolean(targetAccountId),
  });

  let captured: IdentityPrint;
  let bearer = '';
  try {
    const auth = await capture.capture();
    const info = auth.account_info ?? extractAccountInfoSync(platform, auth);
    const cookies = auth.cookies ?? [];
    bearer = auth.bearer ?? '';
    captured = {
      identity: info['identifier'] ?? '',
      label: info['label'] ?? '',
      fingerprint: cookieFingerprint(cookies),
      cookies: cookies.length,
    };
  } catch (error) {
    // ⚠️ 用户在页面上点了「✕ 取消」不是失败，是正常选择 —— 别打印成「捕获失败」
    if (error instanceof LoginCancelledError) {
      console.log('已取消，未写入任何文件。');
      return 1;
    }
    console.error(`捕获失败: ${String(error)}`);
    return 1;
  }

  if (captured.cookies === 0) {
    console.error('❌ 没有抓到任何 cookie —— 可能没登录成功。未写入任何文件。');
    await capture.dispose();
    return 1;
  }

  /* ---------------- 4. 定账号名（含去重校验） ---------------- */
  let finalId: string;

  if (targetAccountId !== null) {
    // 用户明确指定了目标账号：核对「登录的身份」和「要更新的人」是否一致
    finalId = targetAccountId;
    const others = existing.filter((acc) => acc.id !== targetAccountId);
    const verdict = detectDuplicate(captured, others);

    if (verdict.kind !== 'fresh') {
      const same =
        verdict.kind === 'same-session'
          ? `与 ${verdict.accountId} 的 Cookie 完全一致（同一个登录态）`
          : `就是 ${verdict.accountId} 这个人`;
      console.log(`\n⚠️  你登录的身份${same}，但指定要写入 ${targetAccountId}。`);
      const proceed = await confirmOrSkip(
        `确定要把 ${verdict.accountId} 的凭证写进 ${targetAccountId} 吗？`,
        interactive,
        options.yes ?? false,
      );
      if (proceed !== true) {
        console.log('已取消，未写入任何文件。');
        await capture.dispose();
        return proceed === null ? 1 : EXIT_CANCELLED;
      }
    }
  } else {
    const verdict = detectDuplicate(captured, existing);

    if (verdict.kind === 'fresh') {
      // 关键体验：账号名**由身份派生**，用户不用自己想 name
      finalId = deriveAccountId([captured.label, captured.identity], existingIds);
    } else if (!interactive) {
      // 非交互：**更新原账号**而不是新建一个 —— 这是唯一无损的选择。
      // （新建会留下两个「同一个人」的账号文件，正是辅助通道并行时
      //   「请等待其他对话生成完毕」的成因。）
      finalId = verdict.accountId;
      const why = verdict.kind === 'same-session' ? 'Cookie 完全一致' : '身份一致';
      console.log(
        `\n⚠️  这份凭证与已有账号 ${finalId} ${why}（同一个人）→ 直接更新该账号。`,
      );
    } else {
      const why =
        verdict.kind === 'same-session'
          ? `Cookie 与 ${verdict.accountId} 完全一致`
          : `身份与 ${verdict.accountId} 一致（同一个人）`;
      console.log(`\n⚠️  这份凭证的${why}。`);

      const action = await selectOne({
        message: '很可能是同一个人的登录态，怎么处理？',
        choices: [
          {
            value: 'update',
            label: `♻️  更新账号 ${verdict.accountId}`,
            hint: '推荐：本来就是同一个人（如 cookie 过期后重新登录）',
          },
          {
            value: 'new',
            label: '➕ 另存为新账号',
            hint: '只有你确定这是**另一个人**时才选（辅助通道需要真的不同账号）',
          },
          {
            value: 'abort',
            label: '✗ 取消',
            hint: '我要登录的是另一个人 → 请先在浏览器里退出登录，再重跑本命令',
          },
        ],
      });

      if (action === null) {
        await capture.dispose();
        return EXIT_CANCELLED;
      }
      if (action === 'abort') {
        console.log('已取消，未写入任何文件。');
        await capture.dispose();
        return 1;
      }
      finalId =
        action === 'update'
          ? verdict.accountId
          : deriveAccountId([captured.label, captured.identity], existingIds);
    }
  }

  /* ---------------- 5. 落盘 ---------------- */
  /* ⚠️ 防覆盖闸门（2026-10-16 两起实测事故）：抓到的是**匿名会话凭证**时**拒绝落盘**。
   * - chatglm 给任何访客发匿名 JWT（`is_guest: true`）→ 曾把两份**真实账号**凭证覆盖成游客凭证；
   * - deepseek 的游客也有 `ds_session_id` cookie，会被提取成 `session:<id>` 身份
   *   → 只看「有没有 identifier」就判定登录成功，还**多出了账号文件**（`session-<hash>.json`）。
   * 判据统一走 `platforms.ts::identityStrength`（`session` = 匿名会话，`unknown` = 什么都没有）。 */
  const strength = identityStrength(platform, capture.capturedAuth);
  if (strength === 'session' || strength === 'unknown') {
    console.log('');
    console.log(`${bold('✗ 只抓到匿名会话凭证，没有写入任何文件。')}`);
    console.log(
      `  ${spec.displayName} 对**未登录的访客**也会下发会话 cookie/token ——` +
        '所以「页面打开完成」不等于「你已经登录」。',
    );
    console.log(
      `  请重跑 ${bold('webaiapi login')}，在弹出的浏览器里**真正登录**` +
        '（页面上能看到自己的用户名）后再继续。',
    );
    if (existing.length > 0) {
      console.log(`  （现有账号未被改动：${existing.map((acc) => acc.id).join(', ')}）`);
    }
    await capture.dispose();
    return 1;
  }

  let file: string;
  try {
    file = capture.saveAs(finalId);
  } catch (error) {
    console.error(`保存凭证失败: ${String(error)}`);
    await capture.dispose();
    return 1;
  }

  /* ---------------- 6. 汇报 ---------------- */
  const after = readExistingAccounts(platform);

  // 记一条调试日志：支持时最常见的问题是「账号名怎么来的 / 为什么覆盖了别人」，
  // 控制台只有结论，日志里留一份「输入 → 判定 → 最终 id」的链条。
  logger.info(
    `[login] ${platform}/${finalId} 凭证已保存` +
      `（身份=${captured.label}/${captured.identity}, cookie=${captured.cookies}, ` +
      `本次指定账号=${targetAccountId ?? '自动派生'}, 保存后账号数=${after.length}）`,
  );

  console.log('');
  console.log(`${cyan('✔')} 凭证已保存`);
  console.log(`  平台: ${spec.displayName} (${platform})`);
  console.log(`  账号: ${bold(finalId)}`);
  console.log(`  身份: ${bold(captured.label)}   ← 请核对是不是你想登录的那个人`);
  console.log(`  Cookie: ${captured.cookies} 个${bearer ? ' · bearer: 有' : ''}`);
  console.log(`  文件: ${file}`);

  if (after.length >= 2) {
    console.log('');
    console.log(`  ${cyan('✓')} ${spec.displayName} 现有 ${after.length} 个账号：`);
    for (const acc of after) {
      console.log(`      ${acc.id.padEnd(16)} ${acc.label}`);
    }
    console.log('  → 辅助通道（压缩/转换与主对话并行）可以启用了。');
  } else if (totalAccountCount() === after.length) {
    console.log('');
    console.log(
      `  提示: 只有 1 个账号时，压缩/转换会与主对话**串行**（功能正常，只是慢）。\n` +
        `        想并行再加一个账号: webaiapi login ${platform} --account acc2`,
    );
  }

  console.log('');
  console.log('下一步:');
  console.log(`  ${dim('webaiapi accounts       查看账号与角色分配')}`);
  console.log(`  ${dim('webaiapi start          启动服务')}`);
  console.log(`  ${dim('（服务正在运行的话，重启它或等 30s 让辅助通道重扫）')}`);

  /* 「完成」闸门：凭证**已经落盘**，浏览器先不关 —— 页面上显示「已捕获登录凭证，
   * 请设置好模型参数后点击完成」，用户点「完成」（或终端回车、超时）才关窗。
   * 好处：他能对着页面核对账号/身份，并在客户端把模型名等参数配置好。 */
  await capture.finish({
    accountId: finalId,
    identity: captured.label,
    modelHint: platform,
  });

  return 0;
}

/* ==================================================================== */
/* logout                                                              */
/* ==================================================================== */

export interface LogoutOptions {
  /** `webaiapi logout <platform>`；缺省时交互选择。 */
  platform?: string;
  /** `--account <id>`：跳过账号询问。 */
  account?: string;
  /** `--yes`：跳过删除确认（脚本用，**非交互环境必需**）。 */
  yes?: boolean;
  /** `--no-input`：即使有 TTY 也走非交互路径。 */
  noInput?: boolean;
}

/**
 * `webaiapi logout` 的完整流程。
 *
 * ## ⚠️ 这里修掉了一个**会静默删错文件**的老问题
 * 旧实现是 `webaiapi logout <platform> [--account x]`，`account` 缺省值写死为
 * `'default'`。于是 `webaiapi logout chatglm`（本意可能只是「看看怎么用」）
 * **直接把 default 账号的凭证删掉了**，而且只在 stdout 说一句「已删除」。
 *
 * 现在：账号必须**显式给出**（`--account`）或**从菜单里选**；
 * 非交互且没给 `--account` 时**直接报错退出**，绝不替用户猜。
 *
 * @returns 退出码：0 成功 / 1 失败或未确认 / 130 用户取消
 */
export async function runLogout(options: LogoutOptions = {}): Promise<number> {
  const interactive = isInteractive() && !options.noInput;
  /** 平台来自命令行 → 没有「上一步」可返回。 */
  const platformFromCli = options.platform;

  let platform = platformFromCli ?? '';

  for (;;) {
    /* ---------------- 1. 选定平台 ---------------- */
    if (!platform) {
      if (!interactive) {
        console.error('非交互环境必须指定平台：webaiapi logout <platform> --account <id> --yes');
        return 1;
      }

      const platformOptions = platformChoices({ onlyWithAccounts: true });
      if (platformOptions.length === 0) {
        console.log('没有任何已捕获的凭证，无需退出登录。');
        return 0;
      }

      // 平台菜单没有上一步 → 类型只放宽到 ABORT（见 runLogin 里的同款说明）
      const picked = await selectOne<string | typeof ABORT>({
        message: '要退出哪个平台的登录？',
        choices: [
          ...platformOptions,
          { value: ABORT, label: '✗ 退出', hint: '等同按 Esc' },
        ],
      });
      if (picked === null || picked === ABORT) return EXIT_CANCELLED;
      platform = picked;
    }

    if (!PLATFORMS[platform]) {
      console.error(`未知平台: ${platform}`);
      return 1;
    }

    /* ---------------- 2. 选定账号 ---------------- */
    // ⚠️ 用 `listAccounts`（**按文件列**）而不是 `readExistingAccounts`
    //    （会被 `loadAuth` 过滤掉无 cookie / JSON 损坏的文件）：
    //    退出登录的职责是「把文件删掉」，那些坏文件**恰恰最需要能删**，
    //    否则用户会卡在「明明有个账号文件，但删不掉、也用不了」。
    const ids = listAccounts(platform);
    if (ids.length === 0) {
      // 只可能是命令行显式指定的平台（菜单里的平台都有账号）
      console.log(`${platformDisplayName(platform)} 没有任何凭证文件。`);
      return 0;
    }

    let account = options.account;
    if (!account) {
      if (!interactive) {
        console.error(
          `非交互环境必须明确指定账号：webaiapi logout ${platform} --account <id> --yes\n` +
            `现有账号: ${ids.join(', ')}`,
        );
        return 1;
      }

      const choices: Choice<string | NavChoice>[] = ids.map((id) => {
        const auth = loadAuth(platform, { accountId: id });
        const label = auth?.account_info?.label ?? auth?.account_info?.identifier ?? '未知身份';
        const cookies = auth?.cookies?.length ?? 0;
        return {
          value: id,
          label: id,
          hint:
            cookies > 0 ? `${label} · ${cookies} 个 cookie` : '⚠️ 无可用 cookie（损坏或未抓全）',
        };
      });
      choices.push(
        // 有上一步就给「返回」，没有就给「取消」（语义不同，不能混用同一个哨兵）
        platformFromCli
          ? { value: ABORT, label: '✗ 取消', hint: '等同按 Esc' }
          : { value: BACK, label: '← 返回上一步（重新选平台）' },
      );

      const picked = await selectOne({
        message: `要删除 ${platformDisplayName(platform)} 的哪个账号？`,
        choices,
      });
      if (picked === null || picked === ABORT) return EXIT_CANCELLED;
      if (picked === BACK) {
        platform = '';
        continue;
      }
      account = picked;
    }

    if (!ids.includes(account)) {
      console.error(`账号 ${account} 不存在。现有账号: ${ids.join(', ')}`);
      return 1;
    }

    return deleteAccount({ platform, account, interactive, yes: options.yes ?? false });
  }
}

/**
 * 确认并删除一个账号的凭证。
 *
 * 从 {@link runLogout} 拆出来：那边变成了带导航的循环，这里是一条直路
 * （只有「确认 → 检查 → 删除」三步）。
 */
async function deleteAccount(ctx: {
  platform: string;
  account: string;
  interactive: boolean;
  yes: boolean;
}): Promise<number> {
  const { platform, account, interactive, yes } = ctx;

  const path = authFilePath(platform, account);
  const auth = loadAuth(platform, { accountId: account });
  const label = auth?.account_info?.label ?? auth?.account_info?.identifier ?? '未知身份';

  const confirmed = await confirmOrSkip(
    `确认删除 ${platform}/${account}（${label}）的凭证？`,
    interactive,
    yes,
  );

  if (confirmed !== true) {
    if (confirmed === null) {
      console.error('非交互环境不删除任何东西：请加 --yes 确认。');
      return 1;
    }
    console.log('已取消，未删除任何文件。');
    return 1;
  }

  if (!existsSync(path)) {
    // 走到这里只可能是「文件在 listAccounts 之后、删除之前被删了」，属于并发操作
    console.error(`凭证文件不存在（可能已被删除）: ${path}`);
    return 1;
  }

  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.error(`删除失败: ${String(error)}`);
    return 1;
  }

  const remaining = listAccounts(platform);
  console.log(`${cyan('✔')} 已删除 ${platform}/${account}（${label}）`);
  console.log(`  文件: ${path}`);
  console.log(
    remaining.length > 0
      ? `  剩余账号: ${remaining.join(', ')}`
      : `  该平台已无账号。再登录: webaiapi login ${platform}`,
  );
  console.log('');
  console.log('（服务正在运行的话，重启它或等 30s 让辅助通道重扫才会生效）');
  return 0;
}


