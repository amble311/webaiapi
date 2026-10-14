/**
 * 交互式命令行提问工具（`webapi login` / `webapi logout` 用）。
 *
 * ## 为什么不引入 `prompts` / `inquirer`
 * 本项目刻意保持**零运行时依赖**（见 `package.json`）。为了两个菜单拉一棵依赖树
 * 不划算，而且这两个库在「非 TTY」下的行为各不相同，反而更难控。
 *
 * ## 结构：纯函数内核 + 薄 IO 外壳
 * 把「怎么画选项列表」「用户敲的这串字符对应哪一项」做成**纯函数**
 * （{@link renderChoiceList} / {@link resolveChoiceInput}），IO（raw mode、readline）
 * 只留最薄一层（{@link selectOne}）。
 *
 * 理由很实际：**伪造 TTY 的单测又慢又脆**，而这里的 bug 恰恰集中在
 * 「空输入该选哪个」「数字越界怎么办」「disabled 项被选中怎么办」这些
 * **纯粹的分支判断**上 —— 拆出来就能直接喂字符串测，不用碰终端。
 *
 * ## ⚠️ 非 TTY 必须有降级路径
 * `webapi login < ...`（管道）、CI、被其他脚本调用时 `stdin` 不是 TTY。
 * 此时 raw mode 不可用（`setRawMode` 直接抛错），**绝不能**硬走交互渲染 ——
 * 那种情况下进程会卡住等一个永远不会来的按键。这里统一退化成
 * 「打印带编号的列表 + 读一行」，与 TTY 路径共用同一套 {@link resolveChoiceInput} 判定。
 */
import { createInterface } from 'node:readline';

/* ==================================================================== */
/* 颜色 / TTY                                                          */
/* ==================================================================== */

/**
 * 是否输出 ANSI 颜色。
 *
 * 遵循 `NO_COLOR` 约定（https://no-color.org），且只在输出为 TTY 时上色 ——
 * 否则 `webapi login > log.txt` 会把转义序列写进文件。
 */
export function supportsColor(): boolean {
  if (process.env['NO_COLOR']) return false;
  return Boolean(process.stdout.isTTY);
}

function wrap(code: number, text: string): string {
  return supportsColor() ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const cyan = (text: string): string => wrap(36, text);
export const bold = (text: string): string => wrap(1, text);
export const dim = (text: string): string => wrap(2, text);

/** 该码点在终端里是否占**两列**（CJK / 全角 / 韩文音节等）。 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首 / 假名 / 汉字
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角字符
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

/**
 * 字符串在终端里占的**列数**。
 *
 * ⚠️ 存在的理由：`String.prototype.length` / `padEnd` 数的是**码元**，
 * 而中文、全角标点在终端占**两列**。用 `padEnd` 对齐「ChatGLM (智谱)」这种
 * 中英混排的表，第二列会参差不齐 —— 菜单看着就是乱的。
 */
export function displayWidth(text: string): number {
  let width = 0;
  // 用 for...of 按**码点**迭代：emoji 之类的代理对要算一个字符
  for (const ch of text) {
    width += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

/** 按**显示宽度**右填空格（`padEnd` 的中英混排安全版）。 */
export function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * 当前是否处于**可交互**环境（两端都是 TTY）。
 *
 * 只要有一端不是 TTY 就不能走 raw mode：`stdout` 被重定向时用户看不到菜单，
 * `stdin` 被重定向时按键根本到不了我们手上。
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/* ==================================================================== */
/* 选项模型（纯数据）                                                   */
/* ==================================================================== */

export interface Choice<T> {
  /** 返回给调用方的值。 */
  value: T;
  /** 显示文本。 */
  label: string;
  /** 补充说明（灰色，跟在 label 后面）。 */
  hint?: string;
  /** 非空表示**当前不可选**，内容是不可选的原因（会显示给用户）。 */
  disabled?: string;
}

/* ==================================================================== */
/* 纯函数内核（可直接单测）                                             */
/* ==================================================================== */

/**
 * 把选项列表渲染成多行文本。
 *
 * 返回 `string[]` 而不是拼好的字符串：调用方需要知道**行数**才能在原地重绘
 * （光标上移 N 行 → 清除 → 重画），而且逐行更好断言。
 */
export function renderChoiceList<T>(
  choices: ReadonlyArray<Choice<T>>,
  selectedIndex: number,
  options: { numbered?: boolean; indent?: string } = {},
): string[] {
  const { numbered = true, indent = '  ' } = options;

  return choices.map((choice, i) => {
    const isSelected = i === selectedIndex;
    const pointer = isSelected ? cyan('❯') : ' ';
    const number = numbered ? `${dim(`${i + 1}.`)} ` : '';
    const label = isSelected ? bold(choice.label) : choice.label;

    let tail = '';
    if (choice.disabled) {
      tail = `  ${dim(`✗ ${choice.disabled}`)}`;
    } else if (choice.hint) {
      tail = `  ${dim(choice.hint)}`;
    }

    return `${pointer} ${indent}${number}${label}${tail}`;
  });
}

/** {@link resolveChoiceInput} 的判定结果。 */
export type ChoiceResolution =
  | { kind: 'ok'; index: number }
  | { kind: 'cancel' }
  | { kind: 'retry'; reason: string };

/**
 * 把用户输入的一行文本解析成「选中了第几项」。
 *
 * 与 {@link selectOne} 的**非 TTY 降级路径**共用同一套规则，保证两条路径
 * 对「空输入 / 数字 / q / 越界」的处理完全一致 —— 否则会出现
 * 「管道里能用、终端里不能用」这种最难复现的差异。
 *
 * 规则：
 * - 空输入（直接回车）→ 默认项（{@link defaultIndex}，未指定则第 1 项）
 * - `数字` → 第 N 项（1 起算）
 * - `q` / `Q` → 取消（返回 `cancel`）
 * - 其余、越界、以及选中 **disabled** 项 → `retry`（带原因，让调用方提示后重问）
 *
 * ⚠️ disabled 项**返回 retry 而不是静默忽略**：用户在非 TTY 下看不到「不可选」
 * 的视觉提示，必须明确告诉他原因，否则他会以为自己选错了数字。
 */
export function resolveChoiceInput<T>(
  raw: string,
  choices: ReadonlyArray<Choice<T>>,
  defaultIndex = 0,
): ChoiceResolution {
  const text = raw.trim();

  if (text === '') {
    return pick(defaultIndex, choices);
  }
  if (text === 'q' || text === 'Q') {
    return { kind: 'cancel' };
  }

  if (!/^\d+$/.test(text)) {
    return { kind: 'retry', reason: `无法识别的输入「${text}」（请输入编号，或 q 取消）` };
  }

  const index = Number(text) - 1;
  return pick(index, choices);
}

function pick<T>(index: number, choices: ReadonlyArray<Choice<T>>): ChoiceResolution {
  const choice = choices[index];
  if (!choice) {
    return { kind: 'retry', reason: `编号超出范围（可选 1~${choices.length}）` };
  }
  if (choice.disabled) {
    return { kind: 'retry', reason: `「${choice.label}」当前不可选：${choice.disabled}` };
  }
  return { kind: 'ok', index };
}

/** 从 `defaultIndex` 开始往后找第一个可选中的项（找不到返回 0）。 */
export function firstSelectableIndex<T>(choices: ReadonlyArray<Choice<T>>): number {
  const found = choices.findIndex((c) => !c.disabled);
  return found >= 0 ? found : 0;
}

/* ==================================================================== */
/* 按键解析（纯函数，可单测）                                           */
/* ==================================================================== */

/** 一个按键事件。 */
export type KeyToken =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'enter' }
  | { kind: 'cancel' } // Esc / Ctrl+D
  | { kind: 'sigint' } // Ctrl+C
  | { kind: 'char'; value: string };

/**
 * 把一段输入切成**逐个按键**。
 *
 * ## ⚠️ 为什么必须做这件事（真实缺陷，不是洁癖）
 * `stdin` 的 `data` 事件**不保证一次只有一个按键**：
 * - 按住方向键时终端会把多个 `\u001b[B` 合并成一个 chunk；
 * - 粘贴、管道、`script` 这类 pty 转发会一次送进来一整串（如 `\u001b[B\r`）；
 * - 高延迟/慢终端下两次按键可能落在同一个 chunk 里。
 *
 * 若像最初那样用一个 `switch (chunk)` 精确匹配整块，**只有恰好等于
 * `'\u001b[B'` 的 chunk 才生效**，其余情况全部落进 `default` 分支被丢掉 ——
 * 表现为「方向键时灵时不灵」「按了回车没反应」，且完全不打日志。
 *
 * ## 返回值里的 `rest`
 * 流式解析时末尾可能是**半个转义序列**（chunk 在 `\u001b` 或 `\u001b[` 处被切开），
 * 这部分要留给下一个 chunk 拼接，所以放在 `rest` 里返回而不是当成按键。
 *
 * 但「单独按下 Esc」产生的**恰好也是**一个孤立 `\u001b` —— 两者无法只靠字节区分。
 * 因此调用方在 `rest` 非空时起一个 ~40ms 的定时器：等不到后续字节，
 * 就带 `flushTrailingEscape: true` 再解析一次，把它判定为 Esc。
 *
 * @param options.flushTrailingEscape 等待超时后的收尾解析：把末尾残缺的转义
 *   序列当作「用户按了 Esc」（不这么做的话按 Esc 会永久挂住）。
 */
export function tokenizeKeys(
  input: string,
  options: { flushTrailingEscape?: boolean } = {},
): { tokens: KeyToken[]; rest: string } {
  const tokens: KeyToken[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i] as string;

    if (ch === '\u001b') {
      const rest = input.slice(i);

      if (rest.startsWith('\u001b[A') || rest.startsWith('\u001bOA')) {
        tokens.push({ kind: 'up' });
        i += 3;
        continue;
      }
      if (rest.startsWith('\u001b[B') || rest.startsWith('\u001bOB')) {
        tokens.push({ kind: 'down' });
        i += 3;
        continue;
      }

      // 其它 CSI 序列（Home/End/PageUp/Delete…）整段吃掉：
      // 不能把 `[` `3` `~` 当字符输入，否则会在列表里触发莫名其妙的跳转
      const csi = /^\u001b\[[0-9;]*[A-Za-z~]/.exec(rest);
      if (csi) {
        i += csi[0].length;
        continue;
      }

      // 可能是被切开的转义序列 → 留到下一个 chunk
      const isPartial =
        rest === '\u001b' || rest === '\u001b[' || rest === '\u001bO' || /^\u001b\[[0-9;]*$/.test(rest);
      if (isPartial) {
        if (options.flushTrailingEscape) {
          tokens.push({ kind: 'cancel' });
          i = input.length;
          continue;
        }
        return { tokens, rest };
      }

      // 完整但未识别的 ESC 序列 → 当作 Esc
      tokens.push({ kind: 'cancel' });
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      tokens.push({ kind: 'enter' });
      i += 1;
      continue;
    }
    if (ch === '\u0003') {
      tokens.push({ kind: 'sigint' });
      i += 1;
      continue;
    }
    if (ch === '\u0004') {
      // Ctrl+D：多数终端下等于 EOF
      tokens.push({ kind: 'cancel' });
      i += 1;
      continue;
    }

    if (ch >= ' ') tokens.push({ kind: 'char', value: ch });
    // 其余控制字符（\u0000 等）直接丢弃
    i += 1;
  }

  return { tokens, rest: '' };
}

/* ==================================================================== */
/* IO 外壳                                                             */
/* ==================================================================== */

/**
 * 读一行输入；**流结束（EOF）时返回 `null`**。
 *
 * ⚠️ 必须区分「用户直接回车」（返回空串）与「输入流结束」（返回 null）：
 * 管道输入用完时 `readline` 只发 `close`，若把它当成空串，调用方会把
 * 「没有输入」误判成「用户选了默认项」，在 CI 里表现为**静默走了默认分支**。
 */
function ask(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.on('close', () => done(null));
    rl.question(question, (answer) => done(answer));
  });
}

/** 读取一段文本输入（可带默认值 / 校验）。取消（EOF）返回 `null`。 */
export async function inputText(options: {
  message: string;
  defaultValue?: string;
  /** 返回非空字符串表示校验失败，内容会作为提示显示给用户。 */
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  const { message, defaultValue, validate } = options;
  const suffix = defaultValue ? ` ${dim(`[${defaultValue}]`)}` : '';

  for (;;) {
    const raw = await ask(`${bold(message)}${suffix} `);
    if (raw === null) return null; // EOF

    const value = raw.trim() === '' ? (defaultValue ?? '') : raw.trim();
    const problem = validate?.(value) ?? null;
    if (problem) {
      console.log(`  ${dim(`✗ ${problem}`)}`);
      continue;
    }
    return value;
  }
}

/** 是 / 否确认。取消（EOF）返回 `null`。 */
export async function confirmYesNo(options: {
  message: string;
  defaultYes?: boolean;
}): Promise<boolean | null> {
  const { message, defaultYes = false } = options;
  const hint = defaultYes ? 'Y/n' : 'y/N';

  for (;;) {
    const raw = await ask(`${bold(message)} ${dim(`[${hint}]`)} `);
    if (raw === null) return null;

    const text = raw.trim().toLowerCase();
    if (text === '') return defaultYes;
    if (['y', 'yes', '是', '对', '好'].includes(text)) return true;
    if (['n', 'no', '否', '不'].includes(text)) return false;
    console.log(`  ${dim('✗ 请输入 y 或 n')}`);
  }
}

/** `stdin` 是否支持 raw mode（Windows 旧终端 / 非 TTY 下返回 false）。 */
function rawModeAvailable(): boolean {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  if (!isInteractive() || typeof stdin.setRawMode !== 'function') return false;
  try {
    stdin.setRawMode(true);
    stdin.setRawMode(false);
    return true;
  } catch {
    return false;
  }
}

/** 非 TTY 降级路径：打印带编号的列表，然后读一行。 */
async function selectOnePlain<T>(
  message: string,
  choices: ReadonlyArray<Choice<T>>,
  defaultIndex: number,
): Promise<T | null> {
  console.log(`\n${bold(message)}`);
  console.log(renderChoiceList(choices, defaultIndex).join('\n'));

  for (;;) {
    const raw = await ask(`${bold('请输入编号')} ${dim('[回车 = 默认项, q = 取消]')} `);
    if (raw === null) return null;

    const resolution = resolveChoiceInput(raw, choices, defaultIndex);
    if (resolution.kind === 'cancel') return null;
    if (resolution.kind === 'retry') {
      console.log(`  ${dim(`✗ ${resolution.reason}`)}`);
      continue;
    }
    return choices[resolution.index]?.value ?? null;
  }
}

/** TTY 路径：raw mode + ↑/↓ 高亮选择。 */
function selectOneTty<T>(
  message: string,
  choices: ReadonlyArray<Choice<T>>,
  defaultIndex: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;

    let selected = firstSelectableIndex(choices);
    if (choices[defaultIndex] && !choices[defaultIndex]?.disabled) selected = defaultIndex;

    let rendered = 0;
    let restores = 0; // 光标隐藏计数，确保 popStyle 与它配平

    /** 已经 resolve 过：后续按键（可能还在缓冲里）必须全部丢弃。 */
    let finished = false;

    /** 跨 chunk 的按键缓冲（用于拼接被切开的转义序列）。 */
    let pending = '';

    /** 「末尾半个转义序列」的等待定时器（超时后判定为 Esc）。 */
    let flushTimer: NodeJS.Timeout | undefined;

    const paint = (): void => {
      // 光标上移到交互块首行行首，再清除到屏幕末尾 → 覆盖式重绘
      if (rendered > 0) out.write(`\u001b[${rendered}A\u001b[0J`);
      const lines = [
        bold(message),
        ...renderChoiceList(choices, selected),
        dim('  ↑/↓ 选择 · Enter 确认 · Esc 取消'),
      ];
      out.write(`${lines.join('\n')}\n`);
      rendered = lines.length;
    };

    const cleanup = (): void => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      out.removeListener('resize', onResize);
      try {
        stdin.setRawMode(false);
      } catch {
        // 终端已关闭时忽略
      }
      stdin.pause();
      out.write(`\u001b[${restores}?25h`);
    };

    /** 结束并留下「一行结论」，避免菜单残留在终端里。 */
    const finish = (index: number | null): void => {
      finished = true;
      cleanup();
      if (rendered > 0) out.write(`\u001b[${rendered}A\u001b[0J`);
      const choice = index === null ? undefined : choices[index];
      if (choice) {
        out.write(`${cyan('✔')} ${message} ${bold(choice.label)}\n`);
        resolve(choice.value);
      } else {
        out.write(`${dim(`✗ ${message}（已取消）`)}\n`);
        resolve(null);
      }
    };

    const move = (delta: number): void => {
      let next = selected;
      // 跳过 disabled 项；绕一圈都没有可选项时原地不动
      for (let step = 0; step < choices.length; step += 1) {
        next = (next + delta + choices.length) % choices.length;
        if (!choices[next]?.disabled) {
          selected = next;
          return;
        }
      }
    };

    /** 处理单个按键。 */
    const applyKey = (token: KeyToken): void => {
      switch (token.kind) {
        case 'up':
          move(-1);
          paint();
          return;

        case 'down':
          move(1);
          paint();
          return;

        case 'enter': {
          const choice = choices[selected];
          if (choice?.disabled) {
            // 高亮停在 disabled 项上（正常情况下到不了这里）→ 给出原因而不是静默接受
            out.write(`\u001b[${rendered}A\u001b[0J`);
            rendered = 0;
            out.write(`${dim(`✗ 「${choice.label}」当前不可选：${choice.disabled}`)}\n`);
            paint();
            return;
          }
          finish(selected);
          return;
        }

        // Esc / Ctrl+D → 取消
        case 'cancel':
          finish(null);
          return;

        // Ctrl+C → **也当作取消**，而不是直接 process.exit()：
        // 登录流程里浏览器可能已经启动，必须让调用方（有 try/finally）自己收尾，
        // 否则会留下一个没人管的 Firefox 进程。
        case 'sigint':
          finish(null);
          return;

        case 'char': {
          // 数字键：直接跳到第 N 项（与降级路径的编号习惯保持一致）
          if (/^\d$/.test(token.value)) {
            const index = Number(token.value) - 1;
            if (choices[index] && !choices[index]?.disabled) {
              selected = index;
              paint();
            }
          }
          return;
        }
      }
    };

    /**
     * 把新到的字节喂给解析器，**逐个**处理解析出来的按键。
     *
     * ⚠️ 必须逐个处理：一次 `data` 事件可能带多个按键（连按方向键、粘贴、
     * pty 转发），整块匹配会漏掉除第一个以外的全部按键。
     */
    const feed = (text: string, flush: boolean): void => {
      pending += text;
      const { tokens, rest } = tokenizeKeys(pending, { flushTrailingEscape: flush });
      pending = rest;

      for (const token of tokens) {
        if (finished) return;
        applyKey(token);
      }

      if (pending !== '') {
        // 末尾是半个转义序列：等 40ms 看还有没有后续字节。
        // 等不到 → 认定用户按的是 Esc（否则单独按 Esc 会永久挂住）。
        if (!flush) {
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            if (!finished && pending !== '') feed('', true);
          }, 40);
        }
      } else if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const onData = (chunk: Buffer | string): void => feed(chunk.toString('utf8'), false);

    const onEnd = (): void => finish(null);
    const onResize = (): void => paint();

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    out.write('\u001b[?25l'); // 隐藏光标，避免它在列表里乱跳
    restores += 1;
    paint();

    stdin.on('data', onData);
    stdin.on('end', onEnd);
    out.on('resize', onResize);
  });
}

/**
 * 让用户从列表里选一项。
 *
 * - TTY：↑/↓ 高亮 + Enter 确认（数字键可直接跳）
 * - 非 TTY（管道 / CI）：打印编号列表，读一行
 * - 两者都用同一套 {@link resolveChoiceInput} 判定，行为一致
 *
 * @returns 选中的值；用户取消（Esc / Ctrl+C / EOF）返回 `null`。
 */
export async function selectOne<T>(options: {
  message: string;
  choices: ReadonlyArray<Choice<T>>;
  defaultIndex?: number;
  /** 强制走非 TTY 路径（`--no-input` 与单测用）。 */
  forcePlain?: boolean;
}): Promise<T | null> {
  const { message, choices, defaultIndex = firstSelectableIndex(choices), forcePlain } = options;

  if (choices.length === 0) return null;
  if (forcePlain || !rawModeAvailable()) {
    return selectOnePlain(message, choices, defaultIndex);
  }
  return selectOneTty(message, choices, defaultIndex);
}

