import pino from 'pino';

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
const REDACTION_MARKER = '...';

function logLevel(): string {
  const level = process.env.DPAY_MCP_LOG_LEVEL?.toLowerCase() ?? 'info';
  return LOG_LEVELS.has(level) ? level : 'info';
}

export const logger = pino(
  {
    level: logLevel(),
    base: { service: 'dpay-mcp' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    redact: {
      paths: [
        'privateKey',
        '*.privateKey',
        'wallet.privateKey',
        'authorization',
        '*.authorization',
        'headers.authorization',
        'token',
        '*.token',
        'tokens',
        '*.tokens',
        'authToken',
        '*.authToken',
        'password',
        '*.password',
      ],
      censor: '[REDACTED]',
    },
  },
  pino.destination({ dest: 2, sync: true }),
);

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function redactAddress(value: string, visibleChars = 6): string {
  const trimmed = value.trim();
  if (trimmed.length <= visibleChars * 2) {
    return trimmed;
  }
  return `${trimmed.slice(0, visibleChars)}${REDACTION_MARKER}${trimmed.slice(-visibleChars)}`;
}

export function redactHex(value: string, visibleChars = 10): string {
  return redactAddress(value, visibleChars);
}

export function previewText(value: string, maxLength = 120): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}${REDACTION_MARKER}`;
}
