import { Suspense } from 'react';
import { MethodError, connectModelenceQueryClient, renderApp } from 'modelence/client';
import { toast, Toaster } from 'react-hot-toast';
import { RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { router } from './router';
import favicon from './assets/favicon.svg';
import './index.css';
import LoadingSpinner from './components/LoadingSpinner';
import { Seo } from './components/Seo';
import { TooltipProvider } from './components/ui/Tooltip';

const queryClient = new QueryClient();
// We mount our own QueryClientProvider; connecting it keeps renderApp from injecting a second one.
connectModelenceQueryClient(queryClient);

function App() {
  return (
    <TooltipProvider delay={150}>
      <Suspense fallback={<LoadingSpinner fullScreen />}>
        {/* Site-wide SEO defaults; pages can override via <Page seo={{...}}> */}
        <Seo />
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: '#10151a',
              color: '#e4eaee',
              border: '1px solid #2e3a45',
              fontSize: '13px',
              maxWidth: '520px',
            },
          }}
        />
        <RouterProvider router={router} />
      </Suspense>
    </TooltipProvider>
  );
}

renderApp({
  routesElement: (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  ),
  errorHandler: (error, methodName) => {
    // LoginPage handles this inline with a resend link; skip the duplicate, less actionable toast there.
    // Dashboard mutations (guards.ts) raise the same code for signed-in, unverified users: those must toast.
    if (error instanceof MethodError && error.code === 'EMAIL_NOT_VERIFIED' && methodName.startsWith('_system.')) {
      return;
    }
    toast.error(error.message);
  },
  loadingElement: <LoadingSpinner fullScreen />,
  // The dashboard renders without any database (it then shows DISCONNECTED with the real reason),
  // so the framework's development setup screen is disabled.
  setupElement: null,
  favicon,
});
