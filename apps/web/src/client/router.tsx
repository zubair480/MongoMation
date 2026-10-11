import { lazy } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouteObject, useLocation, useSearchParams } from 'react-router';
import { useSession } from 'modelence/client';
import { useEmailVerificationStatus } from './lib/verificationStatus';

// Handles the email verification ?status= param on whatever route it lands on.
function RootLayout() {
  useEmailVerificationStatus();
  return <Outlet />;
}

// For guest-only routes (login, signup) - redirects to the dashboard if already logged in
function GuestRoute() {
  const { user } = useSession();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const encodedRedirect = searchParams.get('_redirect');
  const redirect = encodedRedirect ? decodeURIComponent(encodedRedirect) : '/';
  // Only same-site paths: never bounce a signed-in user to another origin.
  const safeRedirect = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/';

  if (user) {
    return <Navigate to={safeRedirect} state={{ from: location }} replace />;
  }

  return <Outlet />;
}

// Public routes (no auth required). The dashboard is read-only for visitors; its job buttons
// ask the visitor to sign in, and the server refuses unauthenticated mutations.
const publicRoutes: RouteObject[] = [
  // Landing: the 3D control room (Open PLC → /plc/:cab). The dashboard moved to /dashboard.
  {
    path: '/',
    Component: lazy(() => import('./pages/RoomPage')),
  },
  {
    path: '/dashboard',
    Component: lazy(() => import('./pages/DashboardPage')),
  },
  {
    path: '/plc/:cab',
    Component: lazy(() => import('./pages/PlcWorkflowPage')),
  },
  {
    path: '/terms',
    Component: lazy(() => import('./pages/TermsPage')),
  },
  {
    path: '/logout',
    Component: lazy(() => import('./pages/LogoutPage')),
  },
  // Public, not guest-only: a reset link may open with a stale session active,
  // which GuestRoute would redirect away.
  {
    path: '/forgot-password',
    Component: lazy(() => import('./pages/ForgotPasswordPage')),
  },
  {
    path: '/reset-password',
    Component: lazy(() => import('./pages/ResetPasswordPage')),
  },
  {
    path: '*',
    Component: lazy(() => import('./pages/NotFoundPage')),
  },
];

// Guest routes (redirect to the dashboard if already logged in)
const guestRoutes: RouteObject[] = [
  {
    path: '/login',
    Component: lazy(() => import('./pages/LoginPage')),
  },
  {
    path: '/signup',
    Component: lazy(() => import('./pages/SignupPage')),
  },
];

export const router = createBrowserRouter([
  {
    Component: RootLayout,
    children: [
      ...publicRoutes,
      {
        Component: GuestRoute,
        children: guestRoutes,
      },
    ],
  },
]);
