'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { DrawerProvider } from '@/components/Drawer';
import { ToastProvider } from '@/components/Toasts';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            // Don't hammer the API on client errors; retry transient ones briefly.
            retry: (count, err) => (err instanceof ApiError ? err.retryable && count < 2 : count < 2),
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DrawerProvider>{children}</DrawerProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
