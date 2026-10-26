// Small, deterministic formatters for the screens. Everything is UTC and locale-free, so the server render and the browser render of a
// time are the same string (no hydration mismatch) and a recorded run reads the same in every time zone.

const iso = (ms: number): string => new Date(ms).toISOString();

export const utcTime = (ms: number): string => iso(ms).slice(11, 19); // 14:02:11
export const utcDateTime = (ms: number): string => `${iso(ms).slice(0, 10)} ${iso(ms).slice(11, 16)} UTC`; // 2026-10-19 08:12 UTC
export const utcStamp = (ms: number): string => `${iso(ms).slice(0, 10)} ${iso(ms).slice(11, 19)} UTC`; // 2026-10-19 08:12:41 UTC

export const money = (v: string): string => `$${v}`;

const whole = (ms: number): number => Math.max(0, Math.round(ms / 1000));

// "12 s", "2 min 10 s". For a wait that is counted down by the producer, not by the screen.
export function duration(ms: number): string {
  const s = whole(ms);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "Oct 19, 2026": the day a run was recorded, in UTC, spelled by this table so that no locale data is involved.
export const utcDay = (ms: number): string => `${MONTHS[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCDate()}, ${new Date(ms).getUTCFullYear()}`;

// "12:26:46.607" and "12:28:47.9": a time with its milliseconds (3 digits) or its tenths of a second (1 digit), UTC.
export const utcTimeMs = (ms: number): string => iso(ms).slice(11, 23);
export const utcTimeTenth = (ms: number): string => iso(ms).slice(11, 21);
