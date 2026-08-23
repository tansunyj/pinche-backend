/**
 * 轻量日志工具：时间戳 + 级别 + 消息
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: Level = (process.env.LOG_LEVEL as Level) || "info";

function write(level: Level, message: string, data?: any) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export default {
  debug: (msg: string, data?: any) => write("debug", msg, data),
  info: (msg: string, data?: any) => write("info", msg, data),
  warn: (msg: string, data?: any) => write("warn", msg, data),
  error: (msg: string, data?: any) => write("error", msg, data),
  startup: (msg: string, data?: any) => console.log(msg, data !== undefined ? data : ""),
  getLevel: () => currentLevel,
};
