// The schedule layer's failure kind, in its own module like lib/operations/workspace/errors.ts.
import { AppError, type ErrorDetails } from "@/lib/errors/appError";

/** A caller error that adapters translate into their transport's invalid-input response. */
export class ScheduleInvalidError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super("SCHEDULE_INVALID", message, details);
    this.name = "ScheduleInvalidError";
  }
}
