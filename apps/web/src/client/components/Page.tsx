/**
 * Page wrapper for the secondary pages (sign in, sign up, password reset, terms, 404).
 * The dashboard itself (pages/DashboardPage.tsx) has its own header with live status lamps.
 */

import React from 'react';
import { Link } from 'react-router';
import { useSession } from 'modelence/client';
import { ArrowLeft } from 'lucide-react';
import LoadingSpinner from '@/client/components/LoadingSpinner';
import { Seo, type SeoProps } from '@/client/components/Seo';
import { BrandMark } from '@/client/components/mm/BrandMark';
import { cn } from '@/client/lib/utils';
import { displayName } from '@/client/lib/format';

interface PageProps {
  children?: React.ReactNode;
  isLoading?: boolean;
  className?: string;
  /** Per-page <head> overrides (title, description, OG image, etc). */
  seo?: SeoProps;
}

function Header() {
  const { user } = useSession();

  return (
    <header className="border-b border-plant-700/80 bg-plant-950/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link to="/" className="flex items-center gap-2.5">
          <BrandMark className="size-8" />
          <span className="font-display text-lg font-bold tracking-tight text-plant-50">
            Mongo<span className="text-leaf-400">Mation</span>
          </span>
        </Link>

        <div className="flex items-center gap-3">
          <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-plant-300 transition-colors hover:text-plant-50">
            <ArrowLeft className="size-3.5" aria-hidden /> Dashboard
          </Link>
          {user ? (
            <>
              <span className="hidden max-w-48 truncate text-[13px] text-plant-400 sm:inline">{displayName(user.handle)}</span>
              <Link
                to="/logout"
                className="rounded-md border border-plant-600 px-3 py-1.5 text-[13px] text-plant-100 transition-colors hover:bg-plant-800"
              >
                Sign out
              </Link>
            </>
          ) : (
            <Link
              to="/login"
              className="rounded-md bg-plant-100 px-3 py-1.5 text-[13px] font-medium text-plant-950 transition-colors hover:bg-white"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

function PageWrapper({ children }: { children: React.ReactNode }) {
  return <div className="bg-blueprint flex min-h-screen max-w-full flex-col overflow-x-hidden text-plant-100">{children}</div>;
}

function PageBody({ children, className, isLoading = false }: PageProps) {
  return (
    <div className="flex min-h-0 w-full flex-1">
      <main className={cn('flex flex-1 flex-col space-y-4 overflow-x-hidden p-4', className)}>
        {isLoading ? (
          <div className="flex h-full w-full items-center justify-center">
            <LoadingSpinner />
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}

export default function Page({ children, className, isLoading = false, seo }: PageProps) {
  return (
    <PageWrapper>
      <Seo {...seo} />
      <Header />
      <PageBody className={className} isLoading={isLoading}>
        {children}
      </PageBody>
    </PageWrapper>
  );
}
