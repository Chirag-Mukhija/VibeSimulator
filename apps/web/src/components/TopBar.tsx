import { useEffect, useState, type ReactNode } from "react";
import { BrandMark, Icon } from "./ui.tsx";

type Theme = "dark" | "light";

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("vibesim:theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // storage blocked: fall back to the host's choice or the system preference
  }
  // A host page (like an artifact viewer) may already have set the reader's theme.
  const host = document.documentElement.dataset.theme;
  if (host === "dark" || host === "light") return host;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("vibesim:theme", next);
    } catch {
      // not persisted; fine
    }
  };
  return [theme, toggle];
}

export function TopBar({ title, subtitle, left, children }: { title?: string; subtitle?: string; left?: ReactNode; children?: ReactNode }) {
  const [theme, toggle] = useTheme();
  return (
    <header className="topbar">
      {left}
      <a className="brand" href="#/"><BrandMark /><span>vibeSimulator</span></a>
      {title && (
        <div className="repo-title">
          <strong className="ellipsis">{title}</strong>
          {subtitle && <span className="ellipsis">{subtitle}</span>}
        </div>
      )}
      <div className="spacer" />
      {children}
      <a className="btn ghost small" href="#/learn"><Icon name="book" size={15} /><span className="hide-sm">Learn</span></a>
      <button className="btn icon ghost" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
        <Icon name={theme === "dark" ? "sun" : "moon"} />
      </button>
    </header>
  );
}
