#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");

const PROJECT_DIR = path.resolve(process.cwd());
const CONFIG_DIR = path.join(PROJECT_DIR, ".codex_timer");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_DIR = path.join(CONFIG_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "timer.log");
const SESSION_ROOT = path.join(os.homedir(), ".codex", "sessions");

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_MESSAGE = "检查当前状态，有什么更新吗？";
const DEFAULT_CONTINUOUS_DELAY_SECONDS = 3;
const DEFAULT_APPROVAL_POLICY = "never";
const DEFAULT_SANDBOX_MODE = "danger-full-access";
const DEFAULT_TRUST_LEVEL = "trusted";
const APPROVAL_POLICY_OPTIONS = [
  {
    key: "1",
    value: "never",
    label: "不确认（默认）",
    description: "完全自动执行，风险最高。",
  },
  {
    key: "2",
    value: "on-request",
    label: "需要确认",
    description: "敏感操作时请求确认，较稳妥。",
  },
  {
    key: "3",
    value: "untrusted",
    label: "仅不可信操作确认",
    description: "只在不可信操作时确认，自动化更强。",
  },
  {
    key: "4",
    value: "on-failure",
    label: "失败后再确认",
    description: "先尝试执行，失败后再请求确认。",
  },
];
const SANDBOX_MODE_OPTIONS = [
  {
    key: "1",
    value: "danger-full-access",
    label: "danger-full-access（默认）",
    description: "无沙箱限制，所有文件操作都允许，自动化最强。",
  },
  {
    key: "2",
    value: "workspace-write",
    label: "workspace-write",
    description: "允许读和工作区写入，更保守。",
  },
  {
    key: "3",
    value: "read-only",
    label: "read-only",
    description: "只读模式，不能写文件。",
  },
];
const TRUST_LEVEL_OPTIONS = [
  {
    key: "1",
    value: "trusted",
    label: "trusted（默认）",
    description: "当前目录视为可信，更适合自动执行。",
  },
  {
    key: "2",
    value: "untrusted",
    label: "untrusted",
    description: "当前目录视为不可信，通常更保守。",
  },
];
const CRON_FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  day: [1, 31],
  month: [1, 12],
  weekday: [0, 7],
};

async function ensureWritableDirectory(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
  const probeFile = path.join(dirPath, ".write_probe");
  await fsp.writeFile(probeFile, "ok", "utf8");
  await fsp.unlink(probeFile);
}

function formatLogLine(level, message) {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  return `${timestamp} - ${level} - ${message}`;
}

async function appendLog(level, message) {
  const line = `${formatLogLine(level, message)}\n`;
  await fsp.appendFile(LOG_FILE, line, "utf8");
  if (level === "ERROR") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

function normalizePreview(text, limit = 80) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "暂无消息";
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
    return "暂无消息";
  }

  return "暂无消息";
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
      throw new Error("cron 字段不能为空");
    }

    let step = 1;
    let base = part;
    if (part.includes("/")) {
      const pieces = part.split("/", 2);
      base = pieces[0];
      step = Number.parseInt(pieces[1], 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`步长必须大于 0: ${part}`);
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
        throw new Error(`无效的范围: ${part}`);
      }
    } else {
      start = Number.parseInt(base, 10);
      end = start;
      if (!Number.isInteger(start)) {
        throw new Error(`无效的取值: ${part}`);
      }
    }

    if (start > end) {
      throw new Error(`范围起点不能大于终点: ${part}`);
    }
    if (start < minimum || end > maximum) {
      throw new Error(`取值超出范围 ${minimum}-${maximum}: ${part}`);
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
    throw new Error("cron 表达式必须包含 5 个字段: 分 时 日 月 周");
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

  throw new Error(`无法在一年内找到匹配时间: ${expression}`);
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

class CodexTimer {
  constructor() {
    this.codex = null;
    this.thread = null;
    this.sessionId = null;
    this.config = {};
    this.running = true;
    this.taskCounter = 0;
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
    const answer = await this.prompt(`${text} [默认: ${defaultValue}]: `);
    return answer || defaultValue;
  }

  async promptPositiveInt(text, defaultValue) {
    while (true) {
      const raw = await this.prompt(`${text} [默认: ${defaultValue}]: `);
      if (!raw) {
        return defaultValue;
      }
      const value = Number.parseInt(raw, 10);
      if (!Number.isInteger(value)) {
        console.log("❌ 请输入整数");
        continue;
      }
      if (value <= 0) {
        console.log("❌ 请输入大于 0 的数字");
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
        if ((payload.cwd || "未知目录") !== PROJECT_DIR) {
          continue;
        }

        sessions.push({
          id: sessionId,
          cwd: payload.cwd || "未知目录",
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
    await appendLog("INFO", `配置已保存到: ${CONFIG_FILE}`);
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
      return `连续模式: 上次结束后等待 ${delay} 秒`;
    }
    return `固定间隔: ${this.config.interval_seconds || DEFAULT_INTERVAL_SECONDS} 秒`;
  }

  describeApprovalPolicy() {
    const policy = this.getApprovalPolicy();
    const mapping = {
      never: "不确认",
      "on-request": "需要确认",
      untrusted: "仅不可信操作确认",
      "on-failure": "失败后再确认",
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

  async promptChoice(title, options, defaultValue) {
    const currentOption = options.find((option) => option.value === defaultValue) || options[0];
    console.log(`\n${title}`);
    options.forEach((option) => {
      console.log(`${option.key}. ${option.label}`);
      console.log(`   ${option.description}`);
    });

    while (true) {
      const choice = await this.prompt(`\n请选择 [默认: ${currentOption.key}]: `);
      const selected = options.find((option) => option.key === (choice || currentOption.key));
      if (selected) {
        return selected.value;
      }
      console.log("❌ 请输入有效选项");
    }
  }

  async promptApprovalPolicy() {
    this.config.approval_policy = await this.promptChoice(
      "🔐 安全确认设置：",
      APPROVAL_POLICY_OPTIONS,
      this.getApprovalPolicy(),
    );
  }

  async promptSandboxMode() {
    this.config.sandbox_mode = await this.promptChoice(
      "📦 沙箱模式设置：",
      SANDBOX_MODE_OPTIONS,
      this.getSandboxMode(),
    );
  }

  async promptTrustLevel() {
    this.config.trust_level = await this.promptChoice(
      "🛡️ 信任级别设置：",
      TRUST_LEVEL_OPTIONS,
      this.getTrustLevel(),
    );
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
      console.log("⚠️  当前目录没有找到可恢复的会话");
      return null;
    }

    console.log("\n当前目录最近会话：");
    sessions.forEach((session, index) => {
      console.log(`${index + 1}. ${session.id}`);
      console.log(`   时间: ${String(session.timestamp).replace("T", " ").replace("Z", "")}`);
      console.log(`   目录: ${session.cwd}`);
      console.log(`   最近消息: ${session.lastUserMessage}`);
    });

    while (true) {
      const choice = (await this.prompt(`\n请选择会话 (1-${sessions.length})，q 返回: `)).toLowerCase();
      if (choice === "q") {
        return null;
      }
      const index = Number.parseInt(choice, 10) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= sessions.length) {
        console.log("❌ 输入无效");
        continue;
      }
      return sessions[index].id;
    }
  }

  async interactiveSelectSession() {
    console.log(`\n${"=".repeat(60)}`);
    console.log("💬 Codex 会话设置");
    console.log("=".repeat(60));
    console.log("1. 创建新会话");
    console.log("2. 从当前目录最近会话中选择");
    console.log("q. 退出");

    while (true) {
      const choice = (await this.prompt("\n请选择 (1/2/q): ")).toLowerCase();
      if (choice === "" || choice === "1") {
        const codex = await this.getCodex();
        this.thread = codex.startThread(this.getThreadOptions());
        this.sessionId = null;
        await appendLog("INFO", "已创建新的 Codex 会话，首次执行后会自动保存会话 ID");
        console.log("✅ 已创建新会话");
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
        await appendLog("INFO", `已恢复会话: ${sessionId}`);
        console.log(`✅ 已恢复会话: ${sessionId}`);
        return true;
      }
      if (choice === "q") {
        return false;
      }
      console.log("❌ 请输入 1、2 或 q");
    }
  }

  async setupTimerConfig() {
    const hasExisting = Boolean(this.config.schedule_mode && this.config.message_mode);
    if (hasExisting) {
      console.log("\n📌 发现已有配置：");
      console.log(`   调度方式: ${this.describeSchedule()}`);
      console.log(`   消息模式: ${this.config.message_mode}`);
      console.log(`   沙箱模式: ${this.describeSandboxMode()}`);
      console.log(`   审批策略: ${this.describeApprovalPolicy()}`);
      console.log(`   信任级别: ${this.describeTrustLevel()}`);
      if (this.config.preset_message) {
        console.log(`   预设消息: ${this.config.preset_message}`);
      }

      if (await this.promptYesNo("是否继续使用当前配置", true)) {
        return;
      }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("⏰ 定时任务配置");
    console.log("=".repeat(60));
    console.log("\n执行间隔设置：");
    console.log("1. 每 N 秒");
    console.log("2. 每 N 分钟");
    console.log("3. 每 N 小时");
    console.log("4. 自定义 cron 表达式");
    console.log("5. 连续执行（上次结束后等待 3 秒自动继续）");

    while (true) {
      const choice = await this.prompt("\n请选择 (1-5): ");
      if (choice === "1") {
        const seconds = await this.promptPositiveInt("请输入秒数", 30);
        this.config.schedule_mode = "interval";
        this.config.interval_seconds = seconds;
        delete this.config.cron_expression;
        delete this.config.continuous_delay_seconds;
        break;
      }
      if (choice === "2") {
        const minutes = await this.promptPositiveInt("请输入分钟数", 5);
        this.config.schedule_mode = "interval";
        this.config.interval_seconds = minutes * 60;
        delete this.config.cron_expression;
        delete this.config.continuous_delay_seconds;
        break;
      }
      if (choice === "3") {
        const hours = await this.promptPositiveInt("请输入小时数", 1);
        this.config.schedule_mode = "interval";
        this.config.interval_seconds = hours * 3600;
        delete this.config.cron_expression;
        delete this.config.continuous_delay_seconds;
        break;
      }
      if (choice === "4") {
        console.log("\ncron 示例：");
        console.log("  */30 * * * *  -> 每 30 分钟");
        console.log("  0 */2 * * *   -> 每 2 小时");
        console.log("  0 9 * * *     -> 每天 9 点");
        while (true) {
          const expression = await this.prompt("请输入 cron 表达式: ");
          try {
            const nextRun = nextCronRun(expression);
            this.config.schedule_mode = "cron";
            this.config.cron_expression = expression;
            delete this.config.interval_seconds;
            delete this.config.continuous_delay_seconds;
            console.log(`✅ 下一次触发时间: ${formatDateTime(nextRun)}`);
            break;
          } catch (error) {
            console.log(`❌ cron 无效: ${error.message}`);
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
      console.log("❌ 请输入 1-5");
    }

    await this.promptSandboxMode();
    await this.promptApprovalPolicy();
    await this.promptTrustLevel();

    console.log("\n📝 任务内容设置：");
    if (this.config.schedule_mode === "continuous") {
      console.log("连续执行模式固定使用同一条消息。");
      const defaultMessage = this.config.preset_message || this.config.last_message || DEFAULT_MESSAGE;
      const presetMessage = await this.promptWithDefault("请输入预设消息", defaultMessage);
      this.config.preset_message = presetMessage;
      this.config.message_mode = "preset";
    } else {
      console.log("1. 使用预设消息（后续自动重复发送）");
      console.log("2. 首次手动输入，后续自动沿用上次消息");
      const choice = await this.prompt("\n请选择 (1/2): ");
      if (choice === "1") {
        const defaultMessage = this.config.preset_message || this.config.last_message || DEFAULT_MESSAGE;
        const presetMessage = await this.promptWithDefault("请输入预设消息", defaultMessage);
        this.config.preset_message = presetMessage;
        this.config.message_mode = "preset";
      } else {
        this.config.message_mode = "manual";
        delete this.config.preset_message;
      }
    }

    await this.persistRuntimeState();

    console.log("\n✅ 配置完成！");
    console.log(`   会话 ID: ${this.sessionId || "新会话（首次执行后保存）"}`);
    console.log(`   调度方式: ${this.describeSchedule()}`);
    console.log(`   消息模式: ${this.config.message_mode}`);
    console.log(`   沙箱模式: ${this.describeSandboxMode()}`);
    console.log(`   审批策略: ${this.describeApprovalPolicy()}`);
    console.log(`   信任级别: ${this.describeTrustLevel()}`);
    console.log("   请求超时: 不限制");
    if (this.config.preset_message) {
      console.log(`   预设消息: ${this.config.preset_message}`);
    }
  }

  async initialize() {
    await this.getCodex();
    this.config = await this.loadConfig();
    const localSessions = await this.listLocalSessions();
    const localSessionIds = new Set(localSessions.map((session) => session.id));
    const savedSessionId = this.config.session_id;

    if (savedSessionId && localSessionIds.has(savedSessionId)) {
      console.log(`\n📌 发现保存的会话: ${savedSessionId}`);
      if (await this.promptYesNo("是否使用这个会话", true)) {
        this.thread = this.codex.resumeThread(savedSessionId, this.getThreadOptions());
        this.sessionId = savedSessionId;
        await appendLog("INFO", `已恢复会话: ${savedSessionId}`);
      } else if (!(await this.interactiveSelectSession())) {
        await appendLog("ERROR", "用户取消了会话初始化");
        return false;
      }
    } else if (savedSessionId) {
      console.log(`\n⚠️ 已忽略保存的会话: ${savedSessionId}`);
      console.log("   该会话不属于当前脚本目录");
      if (!(await this.interactiveSelectSession())) {
        await appendLog("ERROR", "用户取消了会话初始化");
        return false;
      }
    } else if (!(await this.interactiveSelectSession())) {
      await appendLog("ERROR", "用户取消了会话初始化");
      return false;
    }

    if (!this.thread) {
      await appendLog("ERROR", "未能初始化会话");
      return false;
    }

    await this.setupTimerConfig();
    await this.rebindThreadWithCurrentConfig();
    return true;
  }

  async getMessageToSend(initial = false) {
    if (this.config.message_mode === "preset") {
      return this.config.preset_message || DEFAULT_MESSAGE;
    }

    const defaultMessage = this.config.last_message || DEFAULT_MESSAGE;
    if (initial) {
      const answer = await this.prompt("\n💬 请输入要发送的消息 (直接回车使用上次): ");
      return answer || defaultMessage;
    }
    return defaultMessage;
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

  async runCodexTurn(message) {
    const turn = await this.thread.run(message);
    if (this.thread.id && this.thread.id !== this.sessionId) {
      this.sessionId = this.thread.id;
    }
    return (turn.finalResponse || "").trim() || "(空响应)";
  }

  async executeTask(message) {
    this.taskCounter += 1;
    const startedAt = new Date();
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📌 任务 #${this.taskCounter} - ${formatDateTime(startedAt)}`);
    console.log(`📤 发送: ${message}`);
    console.log("=".repeat(60));
    console.log("⏳ 正在等待 Codex 响应，不限制超时时间...");

    let elapsed = 0;
    const progressTimer = setInterval(() => {
      elapsed += 5;
      console.log(`   已等待 ${elapsed} 秒...`);
    }, 5000);

    try {
      const response = await this.runCodexTurn(message);
      clearInterval(progressTimer);

      this.config.last_message = message;
      await this.persistRuntimeState();

      const responseFile = path.join(CONFIG_DIR, `response_${timestampForFilename(new Date())}.txt`);
      const output = [
        `时间: ${formatDateTime(startedAt)}`,
        `消息: ${message}`,
        `会话ID: ${this.sessionId || "未分配"}`,
        "=".repeat(60),
        response,
        "",
      ].join("\n");
      await fsp.writeFile(responseFile, output, "utf8");

      console.log(`\n📥 响应摘要 (长度: ${response.length} 字符):`);
      console.log("-".repeat(40));
      console.log(response.length > 500 ? `${response.slice(0, 500)}...` : response);
      console.log("-".repeat(40));
      console.log(`✅ 完整响应已保存到: ${responseFile}`);

      await appendLog("INFO", `任务 #${this.taskCounter} 执行成功`);
    } catch (error) {
      clearInterval(progressTimer);
      await appendLog("ERROR", `任务执行失败: ${error.message}`);
      console.log(`❌ 任务执行失败: ${error.message}`);
    }
  }

  async runLoop() {
    if (!(await this.initialize())) {
      await appendLog("ERROR", "初始化失败");
      return;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("🚀 定时任务已启动");
    console.log("=".repeat(60));
    console.log(`会话: ${this.sessionId || "新会话（首次执行后保存）"}`);
    console.log(`调度: ${this.describeSchedule()}`);
    console.log(`模式: ${this.config.message_mode || "manual"}`);
    console.log("按 Ctrl+C 停止");
    console.log("=".repeat(60));

    const initialMessage = await this.getMessageToSend(true);
    if (initialMessage) {
      await this.executeTask(initialMessage);
    }

    while (this.running) {
      const { seconds, nextRun } = this.getNextDelay();
      console.log(`\n⏱️  下次执行时间: ${formatDateTime(nextRun)}`);
      await sleep(seconds * 1000);
      if (!this.running) {
        break;
      }
      const message = await this.getMessageToSend(false);
      if (message) {
        await this.executeTask(message);
      }
    }
  }

  async cleanup() {
    this.running = false;
    await appendLog("INFO", "定时任务已停止");
    await this.closePrompt();
  }
}

async function cli() {
  await ensureWritableDirectory(CONFIG_DIR);
  await ensureWritableDirectory(LOG_DIR);

  const timer = new CodexTimer();
  const signalHandler = async () => {
    console.log("\n\n🛑 收到停止信号，正在关闭...");
    timer.running = false;
  };

  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  try {
    await timer.runLoop();
  } catch (error) {
    await appendLog("ERROR", `未处理异常: ${error.stack || error.message}`);
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
  extractLastUserMessage,
  nextCronRun,
  normalizePreview,
  parseCronField,
  PROJECT_DIR,
  CONFIG_DIR,
};

if (require.main === module) {
  cli();
}
