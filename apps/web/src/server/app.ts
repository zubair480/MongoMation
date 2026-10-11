import { startApp } from 'modelence/server';
import mongomationModule from '@/server/mongomation';

startApp({
  modules: [mongomationModule],

  email: {
    // Without this the reset link redirects to the site root and dead-ends.
    passwordReset: {
      redirectUrl: '/reset-password',
    },
  },

  // No `security.frameAncestors` override: the dashboard can only be framed by itself (CSP
  // frame-ancestors 'self' + X-Frame-Options SAMEORIGIN), so its job buttons cannot be clickjacked.
  // No migrations: the template's demo-user migration (public demo credentials) was removed.
});
