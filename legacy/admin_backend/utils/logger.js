/**
 * 日志工具模块 - 支持日志级别配置
 *
 * 环境变量：
 *   LOG_LEVEL - 日志级别，可选值：debug < info < warn < error < silent
 *   默认值为 info
 *
 * 使用方式：
 *   const logger = require('./utils/logger');
 *   logger.debug('调试信息');
 *   logger.info('普通信息');
 *   logger.warn('警告信息');
 *   logger.error('错误信息');
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const currentLevel = process.env.LOG_LEVEL || 'info';
const currentLevelValue = LOG_LEVELS[currentLevel] ?? LOG_LEVELS.info;

/**
 * 格式化日志消息
 */
function formatMessage(level, args) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

  if (typeof args[0] === 'string') {
    return [`${prefix} ${args[0]}`, ...args.slice(1)];
  }

  return [prefix, ...args];
}

const logger = {
  /**
   * 调试日志（最低级别）
   */
  debug(...args) {
    if (currentLevelValue <= LOG_LEVELS.debug) {
      console.log(...formatMessage('debug', args));
    }
  },

  /**
   * 普通信息日志
   */
  info(...args) {
    if (currentLevelValue <= LOG_LEVELS.info) {
      console.log(...formatMessage('info', args));
    }
  },

  /**
   * 警告日志
   */
  warn(...args) {
    if (currentLevelValue <= LOG_LEVELS.warn) {
      console.warn(...formatMessage('warn', args));
    }
  },

  /**
   * 错误日志
   */
  error(...args) {
    if (currentLevelValue <= LOG_LEVELS.error) {
      console.error(...formatMessage('error', args));
    }
  },

  /**
   * 启动日志（不受日志级别限制，始终输出）
   */
  startup(...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [STARTUP]`, ...args);
  },

  /**
   * 获取当前日志级别
   */
  getLevel() {
    return currentLevel;
  },

  /**
   * 是否启用指定级别的日志
   */
  isEnabled(level) {
    return (LOG_LEVELS[level] ?? LOG_LEVELS.info) >= currentLevelValue;
  },
};

module.exports = logger;
