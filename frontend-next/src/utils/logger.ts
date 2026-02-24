type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function log(level: LogLevel, ...args: unknown[]): void {
  if (typeof window === 'undefined') return
  if (level === 'debug' && process.env.NODE_ENV === 'production') return
  console[level]('[TA]', ...args)
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
}
