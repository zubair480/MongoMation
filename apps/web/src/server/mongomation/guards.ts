// Who may write, and how often. Applied in front of every mutation of the mongomation module:
//   1. signed in                                   (AuthError 401)
//   2. verified email, unless disabled by config   (AuthError 401, code EMAIL_NOT_VERIFIED)
//   3. role `operator` / `admin` when `mongomation.requireOperatorRole` is on (AuthError 403-style)
//   4. Modelence rate limits per user and per IP   (RateLimitError 429)
// Rules are declared on the Module (`rateLimits`) and consumed here with `consumeRateLimit`.
import { AuthError, time } from 'modelence';
import { consumeRateLimit, dbUsers, getConfig, ObjectId, type RateLimitRule, type UserInfo } from 'modelence/server';

export type MethodCtx = {
  user: UserInfo | null;
  roles?: string[];
  connectionInfo?: { ip?: string };
};

export type Bucket = 'mm.job' | 'mm.note' | 'mm.ai' | 'mm.ops';

export const rateLimits: RateLimitRule[] = [
  // Job requests: a burst of a few clicks is fine, a script hammering the worker queue is not.
  { bucket: 'mm.job', type: 'user', window: time.minutes(1), limit: 6 },
  { bucket: 'mm.job', type: 'user', window: time.hours(1), limit: 60 },
  { bucket: 'mm.job', type: 'ip', window: time.minutes(1), limit: 12 },
  { bucket: 'mm.note', type: 'user', window: time.minutes(1), limit: 10 },
  { bucket: 'mm.note', type: 'ip', window: time.minutes(1), limit: 30 },
  // AI explanations cost money on the configured provider.
  { bucket: 'mm.ai', type: 'user', window: time.minutes(10), limit: 5 },
  { bucket: 'mm.ai', type: 'user', window: time.days(1), limit: 40 },
  { bucket: 'mm.ops', type: 'user', window: time.minutes(1), limit: 20 },
];

export function requireUser(user: UserInfo | null): UserInfo {
  if (!user) throw new AuthError('Sign in to send requests to the MongoMation worker');
  return user;
}

export function hasAnyRole(user: UserInfo | null, roles: string[]): boolean {
  return !!user && roles.some((r) => user.hasRole(r));
}

export async function isVerified(user: UserInfo): Promise<boolean> {
  if (!ObjectId.isValid(user.id)) return false;
  const doc = await dbUsers.findOne({ _id: new ObjectId(user.id) });
  return !!doc?.emails?.some((e) => e.verified);
}

async function limit(bucket: Bucket, ctx: MethodCtx, user: UserInfo) {
  await consumeRateLimit({
    bucket,
    type: 'user',
    value: user.id,
    message: 'Too many requests from this account. Wait a minute and try again.',
  });
  const ip = ctx.connectionInfo?.ip;
  if (ip) {
    await consumeRateLimit({ bucket, type: 'ip', value: ip, message: 'Too many requests from this network. Wait a minute.' });
  }
}

/** Runs the full guard chain; returns the signed-in user. */
export async function guard(bucket: Bucket, ctx: MethodCtx, opts: { roles?: string[] } = {}): Promise<UserInfo> {
  const user = requireUser(ctx.user);
  if (getConfig('mongomation.requireVerifiedEmail') !== false && !(await isVerified(user))) {
    throw new AuthError('Verify your email address before sending requests', 'EMAIL_NOT_VERIFIED');
  }
  const roles =
    opts.roles ?? (getConfig('mongomation.requireOperatorRole') === true ? ['operator', 'admin'] : undefined);
  if (roles && !hasAnyRole(user, roles)) {
    throw new AuthError(`This action needs the ${roles.join(' or ')} role (assign it in the Modelence Cloud dashboard)`, 'FORBIDDEN');
  }
  await limit(bucket, ctx, user);
  return user;
}

/** Wraps an existing mutation handler with `guard` (keeps the handler's own checks). */
export function guarded<A, R>(bucket: Bucket, handler: (args: A, ctx: MethodCtx) => Promise<R>) {
  return async (args: A, ctx: MethodCtx): Promise<R> => {
    await guard(bucket, ctx);
    return handler(args, ctx);
  };
}
