// Shared app state and the small set of UI primitives every screen uses.
// Motion only where it carries meaning: sheet in/out, toast feedback, value changes.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AnimatePresence, animate, motion, useDragControls, useReducedMotion } from 'motion/react';
import { X } from '@phosphor-icons/react';
import type { Api, Me } from './api.ts';
import type { Booking, LedgerEntry, Product, SessionType, TrainerPublic } from './domain.ts';
import { initials } from './theme.ts';
import { useI18n } from './i18n.ts';

export interface AppState {
  api: Api;
  trainer: TrainerPublic;
  types: SessionType[];
  products: Product[];
  me: Me;
  bookings: Booking[];
  ledger: LedgerEntry[];
  balance: number;
  dark: boolean; // the look is showing its dark palette right now
  refresh(): Promise<void>;
  path: string;
  navigate(path: string): void;
  toast(text: string, tone?: 'ok' | 'error'): void;
}

export const AppContext = createContext<AppState | null>(null);
export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp() used outside <AppContext>');
  return state;
}

/** A short vibration on confirmations (Android). Never on every tap. */
export function haptic(ms = 12) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator && !matchMedia('(prefers-reduced-motion: reduce)').matches) navigator.vibrate(ms);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
};

export function Button({ variant = 'primary', size = 'md', loading, icon, block, className = '', disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} btn-${size}${block ? ' btn-block' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className="dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      ) : (
        icon
      )}
      {children !== undefined && <span>{children}</span>}
    </button>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose(): void; title: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const drag = useDragControls();
  const panel = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  // Callers pass a new onClose on every render: the focus effect must run only on open/close.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <div className="sheet-layer">
          <motion.div className="sheet-backdrop" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.div
            ref={panel}
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            initial={reduce ? { opacity: 0 } : { y: '100%' }}
            animate={reduce ? { opacity: 1 } : { y: 0 }}
            exit={reduce ? { opacity: 0 } : { y: '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            drag={reduce ? false : 'y'}
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.7 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 650) onClose();
            }}
          >
            <div className="sheet-head" onPointerDown={(e) => drag.start(e)}>
              <span className="sheet-grip" aria-hidden />
              <h2 className="display sheet-title">{title}</h2>
              <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
                <X size={20} weight="bold" />
              </button>
            </div>
            <div className="sheet-body">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

interface ToastItem {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

export function useToasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === 'error' ? 4800 : 3000);
  }, []);
  return { items, show };
}

export function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {items.map((x) => (
          <motion.div
            key={x.id}
            className={`toast toast-${x.tone}`}
            initial={{ y: -18, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -12, opacity: 0, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
          >
            {x.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Sessions left as a ring; the number counts up without re-rendering React. */
export function Ring({ value, max, label, size = 124, stroke = 9 }: { value: number; max: number; label: string; size?: number; stroke?: number }) {
  const reduce = useReducedMotion();
  const num = useRef<HTMLSpanElement>(null);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

  useEffect(() => {
    const el = num.current;
    if (!el) return;
    if (reduce) {
      el.textContent = String(value);
      return;
    }
    const ctl = animate(0, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1], onUpdate: (v) => (el.textContent = String(Math.round(v))) });
    return () => ctl.stop();
  }, [value, reduce]);

  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <motion.circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ duration: reduce ? 0 : 1.1, ease: [0.16, 1, 0.3, 1] }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-num display" ref={num} aria-hidden>
        {value}
      </span>
    </div>
  );
}

/** A row of toggle buttons, one pressed at a time. */
export function Segmented<T extends string>({ id, label, options, value, onChange }: { id: string; label: string; options: { value: T; label: string }[]; value: T; onChange(v: T): void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} className="segmented-item" onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="segmented-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          <span className="segmented-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function Skeleton({ h = 16, w = '100%', r }: { h?: number; w?: number | string; r?: number }) {
  return <span className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden />;
}

export function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden>
        {icon}
      </span>
      <p className="empty-title">{title}</p>
      {body && <p className="empty-body">{body}</p>}
      {action}
    </div>
  );
}

/** The trainer's logo, or a monogram in the brand color when there is none. */
export function Mark({ trainer, size = 40 }: { trainer: TrainerPublic; size?: number }) {
  return trainer.theme.logo ? (
    <img className="mark" src={trainer.theme.logo} alt="" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className="mark mark-mono display" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {initials(trainer.name)}
    </span>
  );
}

export function ErrorState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="empty" role="alert">
      <p className="empty-title">{text}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}
