import { z } from 'zod';
import { ModelenceError, ValidationError } from 'modelence';

/** A precondition does not hold (unverified scene, stale rig, ...). Sent to the client as HTTP 409. */
export class BlockedError extends ModelenceError {
  status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'BlockedError';
    this.code = 'BLOCKED';
  }
}

/** Atlas is not configured or not reachable, so the request cannot be recorded. HTTP 503. */
export class DisconnectedError extends ModelenceError {
  status = 503;

  constructor(message: string) {
    super(message);
    this.name = 'DisconnectedError';
    this.code = 'DISCONNECTED';
  }
}

/** Validates method arguments; failures become a readable 400 instead of a raw zod dump. */
export function parseArgs<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join('.') : 'arguments'}: ${issue.message}`)
      .join('; ');
    throw new ValidationError(message || 'Invalid arguments');
  }
  return result.data;
}
