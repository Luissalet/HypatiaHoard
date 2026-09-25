import React from 'react';

// ─── Button ───────────────────────────────────────────────────────────────────

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  children,
  disabled,
  ...props
}: ButtonProps) {
  const base = 'inline-flex items-center justify-center font-body font-medium rounded-lg transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-ink-900 disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    primary: 'bg-amber-500 hover:bg-amber-400 text-ink-900 focus:ring-amber-500 shadow-sm',
    secondary: 'bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600 focus:ring-ink-500',
    ghost: 'bg-transparent hover:bg-ink-800 text-ink-300 hover:text-ink-100 focus:ring-ink-600',
    danger: 'bg-rose-600 hover:bg-rose-500 text-white focus:ring-rose-500',
  };

  const sizes = {
    sm: 'text-xs px-3 py-1.5 gap-1.5',
    md: 'text-sm px-4 py-2 gap-2',
    lg: 'text-base px-5 py-2.5 gap-2',
  };

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  );
}

// ─── Input ────────────────────────────────────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Input({ label, error, hint, className = '', id, ...props }: InputProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-ink-400 uppercase tracking-widest">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`bg-ink-800 border ${error ? 'border-rose-500' : 'border-ink-600'} text-ink-100 rounded-lg px-3 py-2 text-sm font-body placeholder:text-ink-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all ${className}`}
        {...props}
      />
      {hint && !error && <p className="text-xs text-ink-500">{hint}</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  );
}

// ─── Textarea ─────────────────────────────────────────────────────────────────

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Textarea({ label, error, hint, className = '', id, ...props }: TextareaProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-ink-400 uppercase tracking-widest">
          {label}
        </label>
      )}
      <textarea
        id={inputId}
        className={`bg-ink-800 border ${error ? 'border-rose-500' : 'border-ink-600'} text-ink-100 rounded-lg px-3 py-2 text-sm font-body placeholder:text-ink-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all resize-none ${className}`}
        {...props}
      />
      {hint && !error && <p className="text-xs text-ink-500">{hint}</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  );
}

// ─── Select ───────────────────────────────────────────────────────────────────

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
}

export function Select({ label, error, className = '', id, children, ...props }: SelectProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-ink-400 uppercase tracking-widest">
          {label}
        </label>
      )}
      <select
        id={inputId}
        className={`bg-ink-800 border ${error ? 'border-rose-500' : 'border-ink-600'} text-ink-100 rounded-lg px-3 py-2 text-sm font-body focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all ${className}`}
        {...props}
      >
        {children}
      </select>
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  );
}

// ─── Badge ────────────────────────────────────────────────────────────────────

interface BadgeProps {
  children: React.ReactNode;
  color?: 'amber' | 'sage' | 'rose' | 'ink' | 'blue';
}

export function Badge({ children, color = 'ink' }: BadgeProps) {
  const colors = {
    amber: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    sage: 'bg-sage-600/20 text-sage-400 border-sage-600/30',
    rose: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
    ink: 'bg-ink-700 text-ink-300 border-ink-600',
    blue: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border font-body ${colors[color]}`}>
      {children}
    </span>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  hover?: boolean;
}

export function Card({ children, className = '', onClick, hover = false }: CardProps) {
  return (
    <div
      className={`bg-ink-800 border border-ink-700 rounded-xl p-5 ${hover ? 'cursor-pointer hover:border-ink-500 hover:bg-ink-750 transition-all duration-150' : ''} ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  if (!open) return null;

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full ${sizes[size]} max-h-[90vh] flex flex-col animate-slide-up`}>
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-ink-700">
            <h2 className="font-display text-lg text-ink-100">{title}</h2>
            <button
              onClick={onClose}
              className="text-ink-400 hover:text-ink-200 transition-colors p-1 rounded-lg hover:bg-ink-700"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className="overflow-y-auto flex-1 px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

interface ProgressProps {
  value: number;
  max: number;
  color?: 'amber' | 'sage' | 'rose';
  className?: string;
}

export function Progress({ value, max, color = 'amber', className = '' }: ProgressProps) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  const colors = {
    amber: 'bg-amber-500',
    sage: 'bg-sage-500',
    rose: 'bg-rose-500',
  };
  return (
    <div className={`h-1.5 bg-ink-700 rounded-full overflow-hidden ${className}`}>
      <div
        className={`h-full ${colors[color]} rounded-full transition-all duration-500`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
      {icon && <div className="text-ink-600 text-4xl">{icon}</div>}
      <div>
        <p className="font-display text-ink-300 text-lg">{title}</p>
        {description && <p className="text-ink-500 text-sm mt-1">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ─── Question type badge ───────────────────────────────────────────────────────

interface TypeBadgeProps {
  type: 'TEST' | 'DESARROLLO' | 'COMPLETAR' | 'PRACTICO';
}

export function TypeBadge({ type }: TypeBadgeProps) {
  const config = {
    TEST: { color: 'amber' as const, label: 'Test' },
    DESARROLLO: { color: 'blue' as const, label: 'Desarrollo' },
    COMPLETAR: { color: 'sage' as const, label: 'Completar' },
    PRACTICO: { color: 'rose' as const, label: 'Práctico' },
  };
  const { color, label } = config[type];
  return <Badge color={color}>{label}</Badge>;
}

// ─── Difficulty stars ──────────────────────────────────────────────────────────

interface DifficultyProps {
  level?: number;
}

export function Difficulty({ level }: DifficultyProps) {
  if (!level) return null;
  return (
    <span className="flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className={`text-xs ${i < level ? 'text-amber-400' : 'text-ink-700'}`}>
          ★
        </span>
      ))}
    </span>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div className="overflow-x-auto scrollbar-hide -mx-1">
      <div className="flex gap-1 bg-ink-850 border border-ink-700 p-1 rounded-xl w-max min-w-full">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium font-body transition-all duration-150 whitespace-nowrap ${
              active === tab.id
                ? 'bg-amber-500 text-ink-900 shadow-sm'
                : 'text-ink-400 hover:text-ink-200 hover:bg-ink-700'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Countdown ────────────────────────────────────────────────────────────────

interface CountdownProps {
  examDate?: string;
}

export function Countdown({ examDate }: CountdownProps) {
  if (!examDate) return null;
  const exam = new Date(examDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((exam.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diff < 0) return <span className="text-xs text-ink-500">Examen pasado</span>;
  if (diff === 0) return <span className="text-xs text-rose-400 font-medium animate-pulse-soft">¡Hoy!</span>;
  if (diff <= 7) return <span className="text-xs text-rose-400 font-medium">Faltan {diff} días</span>;
  if (diff <= 30) return <span className="text-xs text-amber-400">Faltan {diff} días</span>;
  return <span className="text-xs text-ink-400">Faltan {diff} días</span>;
}

// ─── Stats summary ─────────────────────────────────────────────────────────────

interface StatsProps {
  seen: number;
  correct: number;
  wrong: number;
}

export function StatsSummary({ seen, correct, wrong }: StatsProps) {
  const pct = seen === 0 ? 0 : Math.round((correct / seen) * 100);
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-ink-500">{seen} vistas</span>
      <span className="text-sage-400">{correct} ✓</span>
      <span className="text-rose-400">{wrong} ✗</span>
      {seen > 0 && <span className="font-medium text-amber-400">{pct}%</span>}
    </div>
  );
}
