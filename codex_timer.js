#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const readline = require("node:readline/promises");

const PROJECT_DIR = path.resolve(process.cwd());
const HOME_CONFIG_DIR = path.join(os.homedir(), ".codex_timer");
const HOME_PREFERENCES_FILE = path.join(HOME_CONFIG_DIR, "preferences.json");
const CONFIG_DIR = path.join(PROJECT_DIR, ".codex_timer");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_DIR = path.join(CONFIG_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "timer.log");
const SESSION_ROOT = path.join(os.homedir(), ".codex", "sessions");

let ACTIVE_LANGUAGE = "zh";

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_CONTINUOUS_DELAY_SECONDS = 3;
const DEFAULT_APPROVAL_POLICY = "never";
const DEFAULT_SANDBOX_MODE = "danger-full-access";
const DEFAULT_TRUST_LEVEL = "trusted";
const LANGUAGE_OPTIONS = [
  {
    key: "1",
    value: "zh",
    label: "中文",
    description: "使用中文界面和提示。",
  },
  {
    key: "2",
    value: "en",
    label: "English",
    description: "Use English for the interface and prompts.",
  },
];
const APPROVAL_POLICY_OPTIONS = [
  {
    key: "1",
    value: "never",
    getLabel: () => tr("不确认（默认）", "Never (Default)"),
    getDescription: () => tr("完全自动执行，风险最高。", "Run automatically without confirmation. Highest risk."),
  },
  {
    key: "2",
    value: "on-request",
    getLabel: () => tr("需要确认", "Ask for confirmation"),
    getDescription: () => tr("敏感操作时请求确认，较稳妥。", "Request confirmation for sensitive actions."),
  },
  {
    key: "3",
    value: "untrusted",
    getLabel: () => tr("仅不可信操作确认", "Confirm only untrusted actions"),
    getDescription: () => tr("只在不可信操作时确认，自动化更强。", "Only confirm untrusted actions. More automation."),
  },
  {
    key: "4",
    value: "on-failure",
    getLabel: () => tr("失败后再确认", "Confirm after failure"),
    getDescription: () => tr("先尝试执行，失败后再请求确认。", "Try first, then ask for confirmation after failure."),
  },
];
const SANDBOX_MODE_OPTIONS = [
  {
    key: "1",
    value: "danger-full-access",
    getLabel: () => "danger-full-access (Default)",
    getDescription: () => tr("无沙箱限制，所有文件操作都允许，自动化最强。", "No sandbox restrictions. Maximum automation."),
  },
  {
    key: "2",
    value: "workspace-write",
    getLabel: () => "workspace-write",
    getDescription: () => tr("允许读和工作区写入，更保守。", "Read access plus workspace writes. More conservative."),
  },
  {
    key: "3",
    value: "read-only",
    getLabel: () => "read-only",
    getDescription: () => tr("只读模式，不能写文件。", "Read-only mode. File writes are blocked."),
  },
];
const TRUST_LEVEL_OPTIONS = [
  {
    key: "1",
    value: "trusted",
    getLabel: () => "trusted (Default)",
    getDescription: () => tr("当前目录视为可信，更适合自动执行。", "Treat the current directory as trusted."),
  },
  {
    key: "2",
    value: "untrusted",
    getLabel: () => "untrusted",
    getDescription: () => tr("当前目录视为不可信，通常更保守。", "Treat the current directory as untrusted."),
  },
];
const CRON_FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  day: [1, 31],
  month: [1, 12],
  weekday: [0, 7],
};
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};
let STATUS_LINE_ACTIVE = false;

async function ensureWritableDirectory(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
  const probeFile = path.join(dirPath, ".write_probe");
  await fsp.writeFile(probeFile, "ok", "utf8");
  await fsp.unlink(probeFile);
}

function tr(zh, en) {
  return ACTIVE_LANGUAGE === "en" ? en : zh;
}

function setActiveLanguage(language) {
  ACTIVE_LANGUAGE = language === "en" ? "en" : "zh";
}

function defaultMessage() {
  return tr("检查当前状态，有什么更新吗？", "Check the current status and tell me what's new.");
}

function normalizeLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["en", "english"].includes(normalized)) {
    return "en";
  }
  if (["zh", "cn", "zh-cn", "chinese", "中文"].includes(normalized)) {
    return "zh";
  }
  return null;
}

async function loadHomePreferences() {
  try {
    const raw = await fsp.readFile(HOME_PREFERENCES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function saveHomePreferences(preferences) {
  await ensureWritableDirectory(HOME_CONFIG_DIR);
  await fsp.writeFile(HOME_PREFERENCES_FILE, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
}

async function promptLanguageSelection(defaultLanguage = null) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\nLanguage / 语言");
    LANGUAGE_OPTIONS.forEach((option) => {
      console.log(`${option.key}. ${option.label}`);
      console.log(`   ${option.description}`);
    });

    const defaultOption = LANGUAGE_OPTIONS.find((option) => option.value === defaultLanguage) || LANGUAGE_OPTIONS[0];

    while (true) {
      const answer = (await rl.question(`\nSelect language / 请选择语言 [default: ${defaultOption.key}]: `)).trim();
      const selected = LANGUAGE_OPTIONS.find((option) => option.key === (answer || defaultOption.key));
      if (selected) {
        return selected.value;
      }
      console.log("Invalid choice / 请输入有效选项");
    }
  } finally {
    rl.close();
  }
}

function formatLogLine(level, message) {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  return `${timestamp} - ${level} - ${message}`;
}

function supportsColor() {
  return Boolean(process.stdout && process.stdout.isTTY);
}

function paint(text, ...codes) {
  if (!supportsColor()) {
    return text;
  }
  return `${codes.join("")}${text}${ANSI.reset}`;
}

function toneColor(tone) {
  if (tone === "success") return ANSI.green;
  if (tone === "warning") return ANSI.yellow;
  if (tone === "error") return ANSI.red;
  if (tone === "accent") return ANSI.magenta;
  return ANSI.cyan;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function charDisplayWidth(char) {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (
      (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
      (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
      (codePoint >= 0x1100 &&
        (
          codePoint <= 0x115f ||
          codePoint === 0x2329 ||
          codePoint === 0x232a ||
          (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
          (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
          (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
          (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
          (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
          (codePoint >= 0xff00 && codePoint <= 0xff60) ||
          (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
          (codePoint >= 0x1f300 && codePoint <= 0x1faf6) ||
          (codePoint >= 0x20000 && codePoint <= 0x3fffd)
        ))
    )
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text) {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += charDisplayWidth(char);
  }
  return width;
}

function padRight(text, width) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function wrapText(text, width) {
  const source = stripAnsi(String(text));
  if (width <= 0) {
    return [source];
  }

  const wrappedLines = [];
  const rawLines = source.split("\n");

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      wrappedLines.push("");
      continue;
    }

    let current = "";
    let currentWidth = 0;

    for (const char of rawLine) {
      const charWidth = charDisplayWidth(char);
      if (currentWidth > 0 && currentWidth + charWidth > width) {
        wrappedLines.push(current.trimEnd());
        current = char === " " ? "" : char;
        currentWidth = char === " " ? 0 : charWidth;
      } else {
        current += char;
        currentWidth += charWidth;
      }
    }

    if (current.length > 0) {
      wrappedLines.push(current.trimEnd());
    }
  }

  return wrappedLines.length > 0 ? wrappedLines : [""];
}

function writeConsoleLine(text = "") {
  if (STATUS_LINE_ACTIVE && process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    STATUS_LINE_ACTIVE = false;
  }
  process.stdout.write(`${text}\n`);
}

function writeStatusLine(text) {
  if (!process.stdout.isTTY) {
    writeConsoleLine(text);
    return;
  }
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(text);
  STATUS_LINE_ACTIVE = true;
}

function clearStatusLine() {
  if (!process.stdout.isTTY || !STATUS_LINE_ACTIVE) {
    return;
  }
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  STATUS_LINE_ACTIVE = false;
}

function printSection(title, tone = "info") {
  writeConsoleLine("");
  writeConsoleLine(paint(title, ANSI.bold, toneColor(tone)));
}

function terminalWidth() {
  return process.stdout && process.stdout.columns ? process.stdout.columns : 100;
}

function constrainPanelWidth(width) {
  return Math.max(20, Math.min(width, terminalWidth() - 4));
}

function printPanel(title, lines = [], tone = "info", options = {}) {
  const content = [title, ...lines].map((line) => String(line));
  const naturalWidth = Math.max(...content.map((line) => displayWidth(line)), 0);
  const width = constrainPanelWidth(options.width || naturalWidth);
  const titleLines = wrapText(title, width);
  const renderedLines = lines.flatMap((line) => wrapText(line, width));
  const horizontal = "─".repeat(width + 2);
  const borderColor = toneColor(tone);
  writeConsoleLine(paint(`┌${horizontal}┐`, borderColor));
  titleLines.forEach((line) => {
    writeConsoleLine(paint(`│ ${padRight(line, width)} │`, borderColor, ANSI.bold));
  });
  if (renderedLines.length > 0) {
    writeConsoleLine(paint(`├${horizontal}┤`, borderColor));
    for (const line of renderedLines) {
      writeConsoleLine(paint(`│ ${padRight(line, width)} │`, borderColor));
    }
  }
  writeConsoleLine(paint(`└${horizontal}┘`, borderColor));
}

function kv(label, value) {
  return `${label}: ${String(value)}`;
}

function panelGroupWidth(panels) {
  const naturalWidth = Math.max(
    ...panels.flatMap((panel) => [panel.title, ...(panel.lines || [])]).map((line) => displayWidth(String(line))),
    0,
  );
  return constrainPanelWidth(naturalWidth);
}

async function appendLog(level, message) {
  const line = `${formatLogLine(level, message)}\n`;
  await fsp.appendFile(LOG_FILE, line, "utf8");
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  const coloredLevel =
    level === "ERROR"
      ? paint(level, ANSI.bold, ANSI.red)
      : level === "INFO"
        ? paint(level, ANSI.bold, ANSI.blue)
        : paint(level, ANSI.bold, ANSI.yellow);
  const consoleLine = `${paint(timestamp, ANSI.gray)} ${coloredLevel} ${message}`;
  if (level === "ERROR") {
    clearStatusLine();
    process.stderr.write(`${consoleLine}\n`);
  } else {
    writeConsoleLine(consoleLine);
  }
}

function quoteAppleScriptString(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function triggerTerminalBell() {
  if (process.stdout && process.stdout.isTTY) {
    process.stdout.write("\u0007");
  }
}

function sendMacNotification(title, message) {
  if (process.platform !== "darwin") {
    return;
  }
  const script = `display notification ${quoteAppleScriptString(message)} with title ${quoteAppleScriptString(title)}`;
  execFile("osascript", ["-e", script], () => {
    // Notifications are best-effort. Ignore failures quietly.
  });
}

function requestMacDockAttention() {
  if (process.platform !== "darwin") {
    return;
  }
  const script = `
ObjC.import('AppKit');
$.NSApplication.sharedApplication;
$.NSApp.requestUserAttention($.NSInformationalRequest);
`;
  execFile("osascript", ["-l", "JavaScript", "-e", script], () => {
    // Dock attention is best-effort. Ignore failures quietly.
  });
}

function notifyTaskFinished(taskNumber, message, outcome = "success") {
  triggerTerminalBell();
  requestMacDockAttention();
  sendMacNotification(
    outcome === "success"
      ? tr(`Codex 任务 #${taskNumber} 完成`, `Codex Task #${taskNumber} Finished`)
      : tr(`Codex 任务 #${taskNumber} 失败`, `Codex Task #${taskNumber} Failed`),
    normalizePreview(message, 60),
  );
}

function normalizePreview(text, limit = 80) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return tr("暂无消息", "No recent message");
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function splitLines(text) {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

async function extractLastUserMessage(sessionFile) {
  try {
    const lines = splitLines(await fsp.readFile(sessionFile, "utf8"));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let payload;
      try {
        payload = JSON.parse(lines[index]);
      } catch {
        continue;
      }

      if (payload.type !== "response_item") {
        continue;
      }

      const message = payload.payload || {};
      if (message.type !== "message" || message.role !== "user") {
        continue;
      }

      const text = (message.content || [])
        .filter((item) => item.type === "input_text" || item.type === "output_text")
        .map((item) => item.text || "")
        .join("")
        .trim();

      if (text) {
        return normalizePreview(text);
      }
    }
  } catch {
    return tr("暂无消息", "No recent message");
  }

  return tr("暂无消息", "No recent message");
}

async function* walkFiles(dirPath) {
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function parseCronField(field, minimum, maximum, { allowSundaySeven = false } = {}) {
  const values = new Set();

  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      throw new Error(tr("cron 字段不能为空", "Cron field cannot be empty"));
    }

    let step = 1;
    let base = part;
    if (part.includes("/")) {
      const pieces = part.split("/", 2);
      base = pieces[0];
      step = Number.parseInt(pieces[1], 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(tr(`步长必须大于 0: ${part}`, `Step must be greater than 0: ${part}`));
      }
    }

    let start;
    let end;
    if (base === "*") {
      start = minimum;
      end = maximum;
    } else if (base.includes("-")) {
      const pieces = base.split("-", 2);
      start = Number.parseInt(pieces[0], 10);
      end = Number.parseInt(pieces[1], 10);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(tr(`无效的范围: ${part}`, `Invalid range: ${part}`));
      }
    } else {
      start = Number.parseInt(base, 10);
      end = start;
      if (!Number.isInteger(start)) {
        throw new Error(tr(`无效的取值: ${part}`, `Invalid value: ${part}`));
      }
    }

    if (start > end) {
      throw new Error(tr(`范围起点不能大于终点: ${part}`, `Range start cannot be greater than end: ${part}`));
    }
    if (start < minimum || end > maximum) {
      throw new Error(tr(`取值超出范围 ${minimum}-${maximum}: ${part}`, `Value out of range ${minimum}-${maximum}: ${part}`));
    }

    for (let candidate = start; candidate <= end; candidate += step) {
      if (allowSundaySeven && candidate === 7) {
        values.add(0);
      } else {
        values.add(candidate);
      }
    }
  }

  return values;
}

function cronMatches(candidate, expression) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(tr("cron 表达式必须包含 5 个字段: 分 时 日 月 周", "Cron expression must contain 5 fields: minute hour day month weekday"));
  }

  const minuteValues = parseCronField(parts[0], ...CRON_FIELD_RANGES.minute);
  const hourValues = parseCronField(parts[1], ...CRON_FIELD_RANGES.hour);
  const dayValues = parseCronField(parts[2], ...CRON_FIELD_RANGES.day);
  const monthValues = parseCronField(parts[3], ...CRON_FIELD_RANGES.month);
  const weekdayValues = parseCronField(parts[4], ...CRON_FIELD_RANGES.weekday, {
    allowSundaySeven: true,
  });

  const cronWeekday = (candidate.getDay() + 0) % 7;
  const dayRestricted = parts[2] !== "*";
  const weekdayRestricted = parts[4] !== "*";

  let dayMatch;
  if (!dayRestricted && !weekdayRestricted) {
    dayMatch = true;
  } else if (dayRestricted && weekdayRestricted) {
    dayMatch = dayValues.has(candidate.getDate()) || weekdayValues.has(cronWeekday);
  } else if (dayRestricted) {
    dayMatch = dayValues.has(candidate.getDate());
  } else {
    dayMatch = weekdayValues.has(cronWeekday);
  }

  return (
    minuteValues.has(candidate.getMinutes()) &&
    hourValues.has(candidate.getHours()) &&
    monthValues.has(candidate.getMonth() + 1) &&
    dayMatch
  );
}

function nextCronRun(expression, after = new Date()) {
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const deadline = new Date(candidate);
  deadline.setDate(deadline.getDate() + 366);

  while (candidate <= deadline) {
    if (cronMatches(candidate, expression)) {
      return new Date(candidate);
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(tr(`无法在一年内找到匹配时间: ${expression}`, `Could not find a matching time within one year: ${expression}`));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`;
}

function parseStopKeywords(raw) {
  return String(raw || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchStopKeyword(text, keywords) {
  const source = String(text || "");
  for (const keyword of keywords || []) {
    if (keyword && source.includes(keyword)) {
      return keyword;
    }
  }
  return null;
}

class CodexTimer {
  constructor() {
    this.codex = null;
    this.thread = null;
    this.sessionId = null;
    this.config = {};
    this.running = true;
    this.stopping = false;
    this.taskCounter = 0;
    this.waitTimeout = null;
    this.waitResolver = null;
    this.readline = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async getCodex() {
    if (!this.codex) {
      const sdk = await import("@openai/codex-sdk");
      this.codex = new sdk.Codex(this.getCodexOptions());
    }
    return this.codex;
  }

  getCodexOptions() {
    return {
      config: {
        trust_level: this.getTrustLevel(),
      },
    };
  }

  getThreadOptions() {
    const options = {
      workingDirectory: PROJECT_DIR,
      skipGitRepoCheck: true,
      sandboxMode: this.getSandboxMode(),
      approvalPolicy: this.getApprovalPolicy(),
    };
    return options;
  }

  getApprovalPolicy() {
    return this.config.approval_policy || DEFAULT_APPROVAL_POLICY;
  }

  getSandboxMode() {
    return this.config.sandbox_mode || DEFAULT_SANDBOX_MODE;
  }

  getTrustLevel() {
    return this.config.trust_level || DEFAULT_TRUST_LEVEL;
  }

  async closePrompt() {
    await this.readline.close();
  }

  async prompt(text) {
    return (await this.readline.question(text)).trim();
  }

  async promptYesNo(text, defaultValue = true) {
    const suffix = defaultValue ? "Y/n" : "y/N";
    const answer = (await this.prompt(`${text} (${suffix}): `)).toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    return answer === "y" || answer === "yes";
  }

  async promptWithDefault(text, defaultValue) {
    const answer = await this.prompt(`${text} [${tr("默认", "default")}: ${defaultValue}]: `);
    return answer || defaultValue;
  }

  async promptPositiveInt(text, defaultValue) {
    while (true) {
      const raw = await this.prompt(`${text} [${tr("默认", "default")}: ${defaultValue}]: `);
      if (!raw) {
        return defaultValue;
      }
      const value = Number.parseInt(raw, 10);
      if (!Number.isInteger(value)) {
        console.log(tr("❌ 请输入整数", "❌ Please enter an integer"));
        continue;
      }
      if (value <= 0) {
        console.log(tr("❌ 请输入大于 0 的数字", "❌ Please enter a number greater than 0"));
        continue;
      }
      return value;
    }
  }

  async listLocalSessions(limit = 20) {
    const sessions = [];

    for await (const sessionFile of walkFiles(SESSION_ROOT)) {
      if (!sessionFile.endsWith(".jsonl")) {
        continue;
      }

      try {
        const content = await fsp.readFile(sessionFile, "utf8");
        const [firstLine] = splitLines(content);
        if (!firstLine) {
          continue;
        }
        const payload = JSON.parse(firstLine).payload || {};
        const sessionId = payload.id;
        if (!sessionId) {
          continue;
        }
        if ((payload.cwd || tr("未知目录", "Unknown directory")) !== PROJECT_DIR) {
          continue;
        }

        sessions.push({
          id: sessionId,
          cwd: payload.cwd || tr("未知目录", "Unknown directory"),
          timestamp: payload.timestamp || "",
          path: sessionFile,
          lastUserMessage: await extractLastUserMessage(sessionFile),
        });
      } catch {
        continue;
      }
    }

    sessions.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    return sessions.slice(0, limit);
  }

  async loadConfig() {
    try {
      const raw = await fsp.readFile(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  async saveConfig() {
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    await fsp.writeFile(CONFIG_FILE, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
    await appendLog("INFO", tr(`配置已保存到: ${CONFIG_FILE}`, `Config saved to: ${CONFIG_FILE}`));
  }

  async persistRuntimeState() {
    if (this.sessionId) {
      this.config.session_id = this.sessionId;
    }
    await this.saveConfig();
  }

  describeSchedule() {
    if (this.config.schedule_mode === "cron") {
      return `cron: ${this.config.cron_expression}`;
    }
    if (this.config.schedule_mode === "continuous") {
      const delay = this.config.continuous_delay_seconds || DEFAULT_CONTINUOUS_DELAY_SECONDS;
      return tr(`连续模式: 上次结束后等待 ${delay} 秒`, `Continuous mode: wait ${delay} seconds after the previous run finishes`);
    }
    return tr(`固定间隔: ${this.config.interval_seconds || DEFAULT_INTERVAL_SECONDS} 秒`, `Fixed interval: ${this.config.interval_seconds || DEFAULT_INTERVAL_SECONDS} seconds`);
  }

  describeApprovalPolicy() {
    const policy = this.getApprovalPolicy();
    const mapping = {
      never: tr("不确认", "Never"),
      "on-request": tr("需要确认", "Ask for confirmation"),
      untrusted: tr("仅不可信操作确认", "Confirm only untrusted actions"),
      "on-failure": tr("失败后再确认", "Confirm after failure"),
    };
    return mapping[policy] || policy;
  }

  describeSandboxMode() {
    const mode = this.getSandboxMode();
    const mapping = {
      "danger-full-access": "danger-full-access",
      "workspace-write": "workspace-write",
      "read-only": "read-only",
    };
    return mapping[mode] || mode;
  }

  describeTrustLevel() {
    const level = this.getTrustLevel();
    const mapping = {
      trusted: "trusted",
      untrusted: "untrusted",
    };
    return mapping[level] || level;
  }

  describeStopKeywords() {
    const keywords = Array.isArray(this.config.stop_keywords) ? this.config.stop_keywords : [];
    if (keywords.length === 0) {
      return tr("未启用", "Disabled");
    }
    return keywords.join(", ");
  }

  async promptChoice(title, options, defaultValue) {
    const currentOption = options.find((option) => option.value === defaultValue) || options[0];
    printSection(title, "accent");
    options.forEach((option) => {
      const label = typeof option.getLabel === "function" ? option.getLabel() : option.label;
      const description = typeof option.getDescription === "function" ? option.getDescription() : option.description;
      writeConsoleLine(`${paint(option.key, ANSI.bold, ANSI.cyan)}. ${label}`);
      writeConsoleLine(`   ${paint(description, ANSI.dim)}`);
    });

    while (true) {
      const choice = await this.prompt(`\n${tr("请选择", "Choose")} [${tr("默认", "default")}: ${currentOption.key}]: `);
      const selected = options.find((option) => option.key === (choice || currentOption.key));
      if (selected) {
        return selected.value;
      }
      console.log(tr("❌ 请输入有效选项", "❌ Please enter a valid option"));
    }
  }

  async promptApprovalPolicy() {
    this.config.approval_policy = await this.promptChoice(
      tr("🔐 安全确认设置：", "🔐 Approval policy:"),
      APPROVAL_POLICY_OPTIONS,
      this.getApprovalPolicy(),
    );
  }

  async promptSandboxMode() {
    this.config.sandbox_mode = await this.promptChoice(
      tr("📦 沙箱模式设置：", "📦 Sandbox mode:"),
      SANDBOX_MODE_OPTIONS,
      this.getSandboxMode(),
    );
  }

  async promptTrustLevel() {
    this.config.trust_level = await this.promptChoice(
      tr("🛡️ 信任级别设置：", "🛡️ Trust level:"),
      TRUST_LEVEL_OPTIONS,
      this.getTrustLevel(),
    );
  }

  async promptStopKeywords() {
    const currentValue = Array.isArray(this.config.stop_keywords) ? this.config.stop_keywords.join(", ") : "";
    printSection(tr("🛑 自动停止关键词", "🛑 Auto-stop keywords"), "warning");
    writeConsoleLine(
      tr(
        "当 Codex 输出包含任意关键词时，自动结束当前任务循环。多个关键词用英文逗号分隔，留空表示禁用。",
        "When the Codex output contains any keyword, the current task loop stops automatically. Separate multiple keywords with commas. Leave empty to disable.",
      ),
    );
    const raw = await this.promptWithDefault(tr("请输入停止关键词", "Enter stop keywords"), currentValue);
    this.config.stop_keywords = parseStopKeywords(raw);
  }

  async rebindThreadWithCurrentConfig() {
    this.codex = null;
    const codex = await this.getCodex();
    if (this.sessionId) {
      this.thread = codex.resumeThread(this.sessionId, this.getThreadOptions());
      return;
    }
    this.thread = codex.startThread(this.getThreadOptions());
  }

  async selectLocalSession() {
    const sessions = await this.listLocalSessions();
    if (sessions.length === 0) {
      printPanel(
        tr("当前目录没有可恢复会话", "No resumable sessions for this directory"),
        [tr("你可以直接创建一个新会话继续。", "You can create a new session and continue.")],
        "warning",
      );
      return null;
    }

    printSection(tr("当前目录最近会话", "Recent sessions for the current directory"), "info");
    const sessionPanels = sessions.map((session, index) => ({
      title: `${index + 1}. ${session.id}`,
      lines: [
        kv(tr("时间", "Time"), String(session.timestamp).replace("T", " ").replace("Z", "")),
        kv(tr("目录", "Directory"), session.cwd),
        kv(tr("最近消息", "Latest message"), session.lastUserMessage),
      ],
    }));
    const width = panelGroupWidth(sessionPanels);
    sessionPanels.forEach((panel) => {
      printPanel(panel.title, panel.lines, "info", { width });
    });

    while (true) {
      const choice = (await this.prompt(tr(`\n请选择会话 (1-${sessions.length})，q 返回: `, `\nSelect a session (1-${sessions.length}), or q to go back: `))).toLowerCase();
      if (choice === "q") {
        return null;
      }
      const index = Number.parseInt(choice, 10) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= sessions.length) {
        console.log(tr("❌ 输入无效", "❌ Invalid input"));
        continue;
      }
      return sessions[index].id;
    }
  }

  async interactiveSelectSession() {
    printPanel(
      tr("💬 Codex 会话设置", "💬 Codex Session Setup"),
      [
        tr("1. 创建新会话", "1. Create a new session"),
        tr("2. 从当前目录最近会话中选择", "2. Select from recent sessions for this directory"),
        tr("q. 退出", "q. Quit"),
      ],
      "accent",
    );

    while (true) {
      const choice = (await this.prompt(tr("\n请选择 (1/2/q): ", "\nChoose (1/2/q): "))).toLowerCase();
      if (choice === "" || choice === "1") {
        const codex = await this.getCodex();
        this.thread = codex.startThread(this.getThreadOptions());
        this.sessionId = null;
        await appendLog("INFO", tr("已创建新的 Codex 会话，首次执行后会自动保存会话 ID", "Created a new Codex session. The session ID will be saved after the first run"));
        printPanel(tr("新会话已创建", "New session created"), [kv(tr("状态", "Status"), tr("等待首次执行后保存会话 ID", "Session ID will be saved after the first run"))], "success");
        return true;
      }
      if (choice === "2") {
        const sessionId = await this.selectLocalSession();
        if (!sessionId) {
          continue;
        }
        const codex = await this.getCodex();
        this.thread = codex.resumeThread(sessionId, this.getThreadOptions());
        this.sessionId = sessionId;
        await appendLog("INFO", tr(`已恢复会话: ${sessionId}`, `Resumed session: ${sessionId}`));
        printPanel(tr("会话已恢复", "Session resumed"), [kv(tr("会话 ID", "Session ID"), sessionId)], "success");
        return true;
      }
      if (choice === "q") {
        return false;
      }
      console.log(tr("❌ 请输入 1、2 或 q", "❌ Please enter 1, 2, or q"));
    }
  }

  async setupTimerConfig() {
    const hasExisting = Boolean(this.config.schedule_mode && this.config.message_mode);
    if (hasExisting) {
      const lines = [
        kv(tr("调度方式", "Schedule"), this.describeSchedule()),
        kv(tr("消息模式", "Message mode"), this.config.message_mode),
        kv(tr("沙箱模式", "Sandbox mode"), this.describeSandboxMode()),
        kv(tr("审批策略", "Approval policy"), this.describeApprovalPolicy()),
        kv(tr("信任级别", "Trust level"), this.describeTrustLevel()),
        kv(tr("停止关键词", "Stop keywords"), this.describeStopKeywords()),
      ];
      if (this.config.preset_message) {
        lines.push(kv(tr("预设消息", "Preset message"), this.config.preset_message));
      }
      printPanel(tr("📌 发现已有配置", "📌 Existing configuration found"), lines, "info");

      if (await this.promptYesNo(tr("是否继续使用当前配置", "Keep using the current configuration"), true)) {
        return;
      }
    }

    printPanel(
      tr("⏰ 定时任务配置", "⏰ Schedule Configuration"),
      [
        tr("1. 每 N 秒", "1. Every N seconds"),
        tr("2. 每 N 分钟", "2. Every N minutes"),
        tr("3. 每 N 小时", "3. Every N hours"),
        tr("4. 自定义 cron 表达式", "4. Custom cron expression"),
        tr("5. 连续执行（上次结束后等待 3 秒自动继续）", "5. Continuous mode (wait 3 seconds after each run)"),
      ],
      "accent",
    );

    while (true) {
      const choice = await this.prompt(tr("\n请选择 (1-5): ", "\nChoose (1-5): "));
      if (choice === "1") {
        const seconds = await this.promptPositiveInt(tr("请输入秒数", "Enter seconds"), 30);
        this.config.schedule_mode = "interval";
        this.config.interval_seconds = seconds;
        delete this.config.cron_expression;
        delete this.config.continuous_delay_seconds;
        break;
      }
      if (choice === "2") {
        const minutes = await this.promptPositiveInt(tr("请输入分钟数", "Enter minutes"), 5);
        this.config.schedule_mode = "interval";
        this.config.interval_seconds = minutes * 60;
        delete this.config.cron_expression;
        delete this.config.continuous_delay_seconds;
        break;
      }
      if (choice === "3") {
        const hours = await this.promptPositiveInt(tr("请输入小时数", "Enter hours"), 1);
        this.config.schedule_mode = "interval";
        this.config.interval_seconds = hours * 3600;
        delete this.config.cron_expression;
        delete this.config.continuous_delay_seconds;
        break;
      }
      if (choice === "4") {
        console.log(tr("\ncron 示例：", "\nCron examples:"));
        console.log(tr("  */30 * * * *  -> 每 30 分钟", "  */30 * * * *  -> every 30 minutes"));
        console.log(tr("  0 */2 * * *   -> 每 2 小时", "  0 */2 * * *   -> every 2 hours"));
        console.log(tr("  0 9 * * *     -> 每天 9 点", "  0 9 * * *     -> every day at 09:00"));
        while (true) {
          const expression = await this.prompt(tr("请输入 cron 表达式: ", "Enter a cron expression: "));
          try {
            const nextRun = nextCronRun(expression);
            this.config.schedule_mode = "cron";
            this.config.cron_expression = expression;
            delete this.config.interval_seconds;
            delete this.config.continuous_delay_seconds;
            console.log(tr(`✅ 下一次触发时间: ${formatDateTime(nextRun)}`, `✅ Next run: ${formatDateTime(nextRun)}`));
            break;
          } catch (error) {
            console.log(tr(`❌ cron 无效: ${error.message}`, `❌ Invalid cron expression: ${error.message}`));
          }
        }
        break;
      }
      if (choice === "5") {
        this.config.schedule_mode = "continuous";
        this.config.continuous_delay_seconds = DEFAULT_CONTINUOUS_DELAY_SECONDS;
        delete this.config.interval_seconds;
        delete this.config.cron_expression;
        break;
      }
      console.log(tr("❌ 请输入 1-5", "❌ Please enter 1-5"));
    }

    await this.promptSandboxMode();
    await this.promptApprovalPolicy();
    await this.promptTrustLevel();
    await this.promptStopKeywords();

    printSection(tr("📝 任务内容设置", "📝 Message Configuration"), "accent");
    if (this.config.schedule_mode === "continuous") {
      console.log(tr("连续执行模式固定使用同一条消息。", "Continuous mode always uses the same preset message."));
      const defaultMessage = this.config.preset_message || this.config.last_message || defaultMessage();
      const presetMessage = await this.promptWithDefault(tr("请输入预设消息", "Enter a preset message"), defaultMessage);
      this.config.preset_message = presetMessage;
      this.config.message_mode = "preset";
    } else {
      console.log(tr("1. 使用预设消息（后续自动重复发送）", "1. Use a preset message for all future runs"));
      console.log(tr("2. 首次手动输入，后续自动沿用上次消息", "2. Enter the first message manually, then reuse it automatically"));
      const choice = await this.prompt(tr("\n请选择 (1/2): ", "\nChoose (1/2): "));
      if (choice === "1") {
        const defaultMessage = this.config.preset_message || this.config.last_message || defaultMessage();
        const presetMessage = await this.promptWithDefault(tr("请输入预设消息", "Enter a preset message"), defaultMessage);
        this.config.preset_message = presetMessage;
        this.config.message_mode = "preset";
      } else {
        this.config.message_mode = "manual";
        delete this.config.preset_message;
      }
    }

    await this.persistRuntimeState();

    const summaryLines = [
      kv(tr("会话 ID", "Session ID"), this.sessionId || tr("新会话（首次执行后保存）", "New session (saved after the first run)")),
      kv(tr("调度方式", "Schedule"), this.describeSchedule()),
      kv(tr("消息模式", "Message mode"), this.config.message_mode),
      kv(tr("沙箱模式", "Sandbox mode"), this.describeSandboxMode()),
      kv(tr("审批策略", "Approval policy"), this.describeApprovalPolicy()),
      kv(tr("信任级别", "Trust level"), this.describeTrustLevel()),
      kv(tr("停止关键词", "Stop keywords"), this.describeStopKeywords()),
      kv(tr("请求超时", "Request timeout"), tr("不限制", "Unlimited")),
    ];
    if (this.config.preset_message) {
      summaryLines.push(kv(tr("预设消息", "Preset message"), this.config.preset_message));
    }
    printPanel(tr("✅ 配置完成", "✅ Configuration saved"), summaryLines, "success");
  }

  async initialize() {
    await this.getCodex();
    this.config = await this.loadConfig();
    const localSessions = await this.listLocalSessions();
    const localSessionIds = new Set(localSessions.map((session) => session.id));
    const savedSessionId = this.config.session_id;

    if (savedSessionId && localSessionIds.has(savedSessionId)) {
      printPanel(
        tr("📌 发现保存的会话", "📌 Found a saved session"),
        [
          kv(tr("会话 ID", "Session ID"), savedSessionId),
          kv(tr("项目目录", "Project"), PROJECT_DIR),
        ],
        "info",
      );
      if (await this.promptYesNo(tr("是否使用这个会话", "Use this session"), true)) {
        this.thread = this.codex.resumeThread(savedSessionId, this.getThreadOptions());
        this.sessionId = savedSessionId;
        await appendLog("INFO", tr(`已恢复会话: ${savedSessionId}`, `Resumed session: ${savedSessionId}`));
      } else if (!(await this.interactiveSelectSession())) {
        await appendLog("ERROR", tr("用户取消了会话初始化", "The user cancelled session initialization"));
        return false;
      }
    } else if (savedSessionId) {
      printPanel(
        tr("⚠️ 已忽略保存的会话", "⚠️ Ignored saved session"),
        [
          kv(tr("会话 ID", "Session ID"), savedSessionId),
          kv(tr("原因", "Reason"), tr("该会话不属于当前脚本目录", "This session does not belong to the current directory")),
        ],
        "warning",
      );
      if (!(await this.interactiveSelectSession())) {
        await appendLog("ERROR", tr("用户取消了会话初始化", "The user cancelled session initialization"));
        return false;
      }
    } else if (!(await this.interactiveSelectSession())) {
      await appendLog("ERROR", tr("用户取消了会话初始化", "The user cancelled session initialization"));
      return false;
    }

    if (!this.thread) {
      await appendLog("ERROR", tr("未能初始化会话", "Failed to initialize the session"));
      return false;
    }

    await this.setupTimerConfig();
    await this.rebindThreadWithCurrentConfig();
    return true;
  }

  async getMessageToSend(initial = false) {
    if (this.config.message_mode === "preset") {
      return this.config.preset_message || defaultMessage();
    }

    const fallbackMessage = this.config.last_message || defaultMessage();
    if (initial) {
      const answer = await this.prompt(tr("\n💬 请输入要发送的消息 (直接回车使用上次): ", "\n💬 Enter the message to send (press Enter to reuse the last one): "));
      return answer || fallbackMessage;
    }
    return fallbackMessage;
  }

  getNextDelay() {
    const now = new Date();
    if (this.config.schedule_mode === "cron") {
      const nextRun = nextCronRun(this.config.cron_expression, now);
      return { seconds: Math.max(0, (nextRun.getTime() - now.getTime()) / 1000), nextRun };
    }
    if (this.config.schedule_mode === "continuous") {
      const delay = this.config.continuous_delay_seconds || DEFAULT_CONTINUOUS_DELAY_SECONDS;
      return { seconds: delay, nextRun: new Date(now.getTime() + delay * 1000) };
    }
    const interval = this.config.interval_seconds || DEFAULT_INTERVAL_SECONDS;
    return { seconds: interval, nextRun: new Date(now.getTime() + interval * 1000) };
  }

  async waitForNextRun(seconds) {
    if (seconds <= 0) {
      return;
    }
    await new Promise((resolve) => {
      this.waitResolver = resolve;
      this.waitTimeout = setTimeout(() => {
        this.waitTimeout = null;
        this.waitResolver = null;
        resolve();
      }, seconds * 1000);
    });
  }

  stopNow() {
    this.running = false;
    this.stopping = true;
    if (this.waitTimeout) {
      clearTimeout(this.waitTimeout);
      this.waitTimeout = null;
    }
    if (this.waitResolver) {
      const resolve = this.waitResolver;
      this.waitResolver = null;
      resolve();
    }
  }

  async runCodexTurn(message) {
    const turn = await this.thread.run(message);
    if (this.thread.id && this.thread.id !== this.sessionId) {
      this.sessionId = this.thread.id;
    }
    return (turn.finalResponse || "").trim() || tr("(空响应)", "(empty response)");
  }

  async executeTask(message) {
    this.taskCounter += 1;
    const startedAt = new Date();
    printPanel(
      tr(`📌 任务 #${this.taskCounter}`, `📌 Task #${this.taskCounter}`),
      [
        kv(tr("开始时间", "Started"), formatDateTime(startedAt)),
        kv(tr("发送内容", "Prompt"), message),
      ],
      "accent",
    );

    let elapsed = 0;
    let spinnerIndex = 0;
    const progressTimer = setInterval(() => {
      elapsed += 1;
      const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
      spinnerIndex += 1;
      writeStatusLine(
        `${paint(frame, ANSI.cyan)} ${tr("等待 Codex 响应", "Waiting for Codex response")} ${paint(`${elapsed}s`, ANSI.bold, ANSI.yellow)}`,
      );
    }, 1000);

    try {
      const response = await this.runCodexTurn(message);
      clearInterval(progressTimer);
      clearStatusLine();

      this.config.last_message = message;
      await this.persistRuntimeState();

      const responseFile = path.join(CONFIG_DIR, `response_${timestampForFilename(new Date())}.txt`);
      const output = [
        `${tr("时间", "Time")}: ${formatDateTime(startedAt)}`,
        `${tr("消息", "Message")}: ${message}`,
        `${tr("会话ID", "Session ID")}: ${this.sessionId || tr("未分配", "Unassigned")}`,
        "=".repeat(60),
        response,
        "",
      ].join("\n");
      await fsp.writeFile(responseFile, output, "utf8");

      const preview = response.length > 500 ? `${response.slice(0, 500)}...` : response;
      await appendLog("INFO", tr(`任务 #${this.taskCounter} 执行成功`, `Task #${this.taskCounter} completed successfully`));
      const matchedKeyword = matchStopKeyword(response, this.config.stop_keywords || []);
      printPanel(
        tr(`✅ 任务 #${this.taskCounter} 完成`, `✅ Task #${this.taskCounter} Completed`),
        [
          kv(tr("耗时", "Duration"), `${elapsed}s`),
          kv(tr("响应长度", "Response length"), `${response.length}`),
          kv(tr("保存位置", "Saved to"), responseFile),
          kv(tr("停止关键词", "Stop keyword"), matchedKeyword || tr("未命中", "No match")),
        ],
        "success",
      );
      printPanel(tr("📥 响应摘要", "📥 Response Preview"), preview.split("\n"), "info");
      if (matchedKeyword) {
        this.running = false;
        await appendLog(
          "INFO",
          tr(`命中停止关键词，自动结束任务: ${matchedKeyword}`, `Matched stop keyword, ending task automatically: ${matchedKeyword}`),
        );
        printPanel(
          tr("🛑 已自动结束任务", "🛑 Task Stopped Automatically"),
          [kv(tr("命中关键词", "Matched keyword"), matchedKeyword)],
          "warning",
        );
      }
      notifyTaskFinished(this.taskCounter, preview, "success");
      return { success: true, response, matchedKeyword };
    } catch (error) {
      clearInterval(progressTimer);
      clearStatusLine();
      await appendLog("ERROR", tr(`任务执行失败: ${error.message}`, `Task failed: ${error.message}`));
      printPanel(
        tr(`❌ 任务 #${this.taskCounter} 失败`, `❌ Task #${this.taskCounter} Failed`),
        [
          kv(tr("耗时", "Duration"), `${elapsed}s`),
          kv(tr("错误", "Error"), error.message),
        ],
        "error",
      );
      notifyTaskFinished(this.taskCounter, error.message, "error");
      return { success: false, response: "", matchedKeyword: null };
    }
  }

  async runLoop() {
    if (!(await this.initialize())) {
      await appendLog("ERROR", tr("初始化失败", "Initialization failed"));
      return;
    }

    printPanel(
      tr("🚀 定时任务已启动", "🚀 Timer Started"),
      [
        kv(tr("项目目录", "Project"), PROJECT_DIR),
        kv(tr("语言", "Language"), ACTIVE_LANGUAGE),
        kv(tr("会话", "Session"), this.sessionId || tr("新会话（首次执行后保存）", "New session (saved after the first run)")),
        kv(tr("调度", "Schedule"), this.describeSchedule()),
        kv(tr("模式", "Mode"), this.config.message_mode || "manual"),
        kv(tr("沙箱", "Sandbox"), this.describeSandboxMode()),
        kv(tr("审批", "Approval"), this.describeApprovalPolicy()),
        kv(tr("信任", "Trust"), this.describeTrustLevel()),
        kv(tr("停止关键词", "Stop keywords"), this.describeStopKeywords()),
        tr("按 Ctrl+C 停止", "Press Ctrl+C to stop"),
      ],
      "success",
    );

    const initialMessage = await this.getMessageToSend(true);
    if (initialMessage) {
      const result = await this.executeTask(initialMessage);
      if (result.matchedKeyword) {
        return;
      }
    }

    while (this.running) {
      const { seconds, nextRun } = this.getNextDelay();
      writeConsoleLine(
        `${paint("⏱", ANSI.cyan)} ${tr("下次执行时间", "Next run")} ${paint(formatDateTime(nextRun), ANSI.bold)} ${paint(`(+${seconds}s)`, ANSI.dim)}`,
      );
      await this.waitForNextRun(seconds);
      if (!this.running) {
        break;
      }
      const message = await this.getMessageToSend(false);
      if (message) {
        const result = await this.executeTask(message);
        if (result.matchedKeyword) {
          break;
        }
      }
    }
  }

  async cleanup() {
    this.stopNow();
    await appendLog("INFO", tr("定时任务已停止", "Timer stopped"));
    await this.closePrompt();
  }
}

async function updateLanguagePreference(explicitLanguage = null) {
  await ensureWritableDirectory(HOME_CONFIG_DIR);
  const homePreferences = await loadHomePreferences();
  let language = normalizeLanguage(explicitLanguage || "");
  if (!language) {
    language = await promptLanguageSelection(homePreferences.language || ACTIVE_LANGUAGE);
  }
  homePreferences.language = language;
  await saveHomePreferences(homePreferences);
  setActiveLanguage(language);
  console.log(tr("✅ 语言偏好已保存", "✅ Language preference saved"));
}

async function initializeLanguagePreference(forcePrompt = false, explicitLanguage = null) {
  await ensureWritableDirectory(HOME_CONFIG_DIR);
  const homePreferences = await loadHomePreferences();

  if (forcePrompt) {
    let language = normalizeLanguage(explicitLanguage || "");
    if (!language) {
      language = await promptLanguageSelection(homePreferences.language || ACTIVE_LANGUAGE);
    }
    homePreferences.language = language;
    await saveHomePreferences(homePreferences);
    setActiveLanguage(language);
    return;
  }

  const savedLanguage = normalizeLanguage(homePreferences.language || "");
  if (savedLanguage) {
    setActiveLanguage(savedLanguage);
    return;
  }

  const language = await promptLanguageSelection(ACTIVE_LANGUAGE);
  homePreferences.language = language;
  await saveHomePreferences(homePreferences);
  setActiveLanguage(language);
}

function parseCliArguments(argv) {
  const args = argv.slice(2);
  const langIndex = args.findIndex((arg) => arg === "-lang" || arg === "--lang");
  if (langIndex !== -1) {
    return {
      mode: "set-language",
      value: args[langIndex + 1] || null,
    };
  }
  return { mode: "run" };
}

async function cli(argv = process.argv) {
  const parsedArgs = parseCliArguments(argv);
  if (parsedArgs.mode === "set-language") {
    await initializeLanguagePreference(true, parsedArgs.value);
    console.log(tr("当前语言已切换", "Current language updated"));
    return;
  }

  await initializeLanguagePreference(false);
  await ensureWritableDirectory(CONFIG_DIR);
  await ensureWritableDirectory(LOG_DIR);

  const timer = new CodexTimer();
  const signalHandler = async () => {
    if (timer.stopping) {
      return;
    }
    writeConsoleLine(tr("\n🛑 收到停止信号，正在关闭...", "\n🛑 Received a stop signal. Shutting down..."));
    timer.stopNow();
  };

  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  try {
    await timer.runLoop();
  } catch (error) {
    await appendLog("ERROR", tr(`未处理异常: ${error.stack || error.message}`, `Unhandled error: ${error.stack || error.message}`));
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await timer.cleanup();
  }
}

module.exports = {
  CodexTimer,
  cli,
  cronMatches,
  displayWidth,
  extractLastUserMessage,
  matchStopKeyword,
  nextCronRun,
  normalizePreview,
  parseCronField,
  parseStopKeywords,
  PROJECT_DIR,
  CONFIG_DIR,
  HOME_PREFERENCES_FILE,
  LANGUAGE_OPTIONS,
  normalizeLanguage,
  parseCliArguments,
  quoteAppleScriptString,
  setActiveLanguage,
  tr,
  wrapText,
};

if (require.main === module) {
  cli();
}
