import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Atom,
  Check,
  Code2,
  FolderGit2,
  Globe2,
  LoaderCircle,
  Smartphone,
  X,
} from "lucide-react";
import type { Project } from "./types";

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`}>
      <Code2 size={small ? 17 : 22} strokeWidth={2.5} />
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
    // Start in the first field so people can type right away; dialogs
    // without fields focus their close button, never a destructive action.
    const timer = setTimeout(
      () =>
        (
          ref.current?.querySelector<HTMLElement>("input,textarea,select") ??
          ref.current?.querySelector<HTMLElement>("button")
        )?.focus(),
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
  const size = large ? 24 : 19;
  return (
    <span className={`project-icon ${template} ${large ? "large" : ""}`}>
      {template === "react" ? (
        <Atom size={size} />
      ) : template === "repo" ? (
        <FolderGit2 size={size} />
      ) : template === "flutter" ? (
        <Smartphone size={size} />
      ) : (
        <Globe2 size={size} />
      )}
    </span>
  );
}
/** Short origin label: GitHub/Git for imported repositories, else the template. */
export function projectKind(project: Project): string {
  if (project.template === "repo")
    return /github\.com/i.test(project.source?.url ?? "") ? "GitHub" : "Git";
  if (project.template === "flutter") return "Flutter";
  return project.template === "react" ? "React" : "Web";
}
/** owner/repo for imported projects, otherwise the template stack. */
export function projectStack(project: Project): string {
  if (project.template === "repo")
    return (
      (project.source?.url ?? "")
        .replace(/\.git$/i, "")
        .split("/")
        .slice(-2)
        .join("/") || "Repositorio Git"
    );
  if (project.template === "flutter")
    return `Flutter · ${project.organization ?? "com.example"}`;
  return project.template === "react" ? "React + Vite" : "HTML · CSS · JS";
}
export function StatusDot({ active }: { active?: boolean }) {
  return <span className={`status-dot ${active ? "active" : ""}`} />;
}
export type Tone = "" | "success" | "danger" | "warning" | "info" | "accent";
export function Tag({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: Tone;
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
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
/** True on phone-sized screens, where side panels become overlays. */
export function isCompactScreen() {
  return window.matchMedia("(max-width: 700px)").matches;
}
/** True when the main input is touch, so Enter should insert a new line. */
export function isTouchInput() {
  return window.matchMedia("(pointer: coarse)").matches;
}
