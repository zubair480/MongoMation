import { startApp } from 'modelence/server';
import { time } from 'modelence';
import { logInfo } from 'modelence/telemetry';
import mongomationModule from '@/server/mongomation';

startApp({
  modules: [mongomationModule],

  // Synced to the Modelence Cloud dashboard, where they are assigned to users.
  roles: {
    admin: { description: 'Acknowledges ops alerts, deletes any note, queues jobs' },
    operator: {
      description: 'Queues engineering jobs and worker commands when mongomation.requireOperatorRole is on; acknowledges ops alerts',
    },
  },

  email: {
    // Without this the reset link redirects to the site root and dead-ends.
    passwordReset: {
      redirectUrl: '/reset-password',
    },
    verification: {
      subject: 'Confirm your MongoMation dashboard account',
    },
    emailVerifiedRedirectUrl: '/?verified=1',
  },

  auth: {
    // Job mutations write to the shared worker queue: tighten the sign-in window a little.
    rateLimits: {
      signin: [{ type: 'ip', window: time.minutes(15), limit: 30 }],
    },
    // Audit trail in Modelence telemetry (ids only, no emails).
    onAfterLogin: ({ user, provider }) => logInfo('mongomation auth: login', { userId: String(user._id), provider }),
    onAfterSignup: ({ user, provider }) => logInfo('mongomation auth: signup', { userId: String(user._id), provider }),
    onAfterEmailVerification: ({ user }) => logInfo('mongomation auth: email verified', { userId: String(user._id) }),
  },

  // No `security.frameAncestors` override: the dashboard can only be framed by itself (CSP
  // frame-ancestors 'self' + X-Frame-Options SAMEORIGIN), so its job buttons cannot be clickjacked.
  // No migrations: the template's demo-user migration (public demo credentials) was removed.
});
