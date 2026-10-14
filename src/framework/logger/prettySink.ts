import type { LogEntry, LogSink } from "./JsonLogger.js";

const LEVEL_LABEL: Record<LogEntry["level"], string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

const COLOUR: Record<LogEntry["level"], string> = {
  debug: "\u001b[90m",
  info: "\u001b[36m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};
const RESET = "\u001b[0m";

function formatValue(value: unknown): string {
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value);
}

/** Formats an entry as one human-readable line: `12:00:00.000 INFO  message key=value …`. */
export function formatPretty(entry: LogEntry, colour = false): string {
  const { time, level, msg, stack, error, ...fields } = entry as LogEntry & {
    stack?: unknown;
    error?: { stack?: unknown };
  };
  const clock = time.slice(11, 23);
  const label = colour ? `${COLOUR[level]}${LEVEL_LABEL[level]}${RESET}` : LEVEL_LABEL[level];
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${formatValue(value)}`);
  const errorSummary =
    error === undefined ? [] : [`error=${formatValue({ ...error, stack: undefined })}`];
  const lines = [[clock, label, msg, ...pairs, ...errorSummary].join(" ")];

  const trace = typeof error?.stack === "string" ? error.stack : stack;
  if (typeof trace === "string") lines.push(trace);
  return lines.join("\n");
}

/** Development sink: readable, coloured when writing to a terminal. */
export const prettySink: LogSink = (entry) => {
  process.stdout.write(`${formatPretty(entry, process.stdout.isTTY)}\n`);
};
