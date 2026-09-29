import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  Code2,
  Globe2,
  LoaderCircle,
  X,
} from "lucide-react";

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`}>
      <Code2 size={small ? 18 : 25} strokeWidth={2.5} />
    </span>
  );
}
export function Spinner() {
  return <LoaderCircle className="spin" size={18} aria-label="Cargando" />;
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = setTimeout(
      () =>
        ref.current
          ?.querySelector<HTMLElement>("input,textarea,button")
          ?.focus(),
      30,
    );
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const nodes = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input,select,textarea,a[href]",
          ) ?? []),
        ];
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = bodyOverflow;
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-heading">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="Cerrar" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function ProjectIcon({
  template,
  large = false,
}: {
  template: string;
  large?: boolean;
}) {
  return (
    <span className={`project-icon ${template} ${large ? "large" : ""}`}>
      {template === "react" ? (
        <Code2 size={large ? 26 : 21} />
      ) : (
        <Globe2 size={large ? 26 : 21} />
      )}
    </span>
  );
}
export function StatusDot({ active }: { active?: boolean }) {
  return <span className={`status-dot ${active ? "active" : ""}`} />;
}
export function Tag({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-link">
      {children}
      <ArrowUpRight size={15} />
    </a>
  );
}
export function CheckLabel({ children }: { children: ReactNode }) {
  return (
    <span className="check-label">
      <Check size={14} />
      {children}
    </span>
  );
}
export function relativeDate(date: string) {
  const delta = Math.max(0, Date.now() - new Date(date).getTime());
  if (delta < 60000) return "Ahora mismo";
  if (delta < 3600000) return `Hace ${Math.floor(delta / 60000)} min`;
  if (delta < 86400000) return `Hace ${Math.floor(delta / 3600000)} h`;
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
  }).format(new Date(date));
}
