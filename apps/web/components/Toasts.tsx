'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface Toast {
  id: number;
  message: string;
  icon: IconName;
  action?: { label: string; run: () => void };
  leaving?: boolean;
}

type Push = (
  message: string,
  opts?: { icon?: IconName; action?: Toast['action']; durationMs?: number },
) => void;

const ToastContext = createContext<Push>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 280);
  }, []);

  const push = useCallback<Push>(
    (message, opts = {}) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, message, icon: opts.icon ?? 'check', action: opts.action }]);
      setTimeout(() => dismiss(id), opts.durationMs ?? (opts.action ? 6500 : 3500));
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.leaving ? ' out' : ''}`} role="status">
            <span className="toast-icon">
              <Icon name={t.icon} />
            </span>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                className="toast-btn"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
