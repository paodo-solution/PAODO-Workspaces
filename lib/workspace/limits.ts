// Agent-loop bounds. The timeout is stored in minutes, the UI's unit; runs convert it to ms.
export const DEFAULT_MAX_RUN_MINUTES = 10;
export const DEFAULT_MAX_ITERATIONS = 100;
export const MAX_WORKSPACE_DESCRIPTION_LENGTH = 4_000;
export const MIN_MAX_RUN_MINUTES = 1;
export const MAX_MAX_RUN_MINUTES = 1_440;
export const MIN_MAX_ITERATIONS = 1;
export const MAX_MAX_ITERATIONS = 500;

export function normalizeMaxRunMinutes(value: unknown): number {
  const minutes = Math.floor(Number(value));
  return Number.isFinite(minutes) && minutes >= MIN_MAX_RUN_MINUTES && minutes <= MAX_MAX_RUN_MINUTES
    ? minutes
    : DEFAULT_MAX_RUN_MINUTES;
}
