import { useCallback, useEffect, useRef, useState } from "react";

export type Theme = "dark" | "light";
const STORAGE_KEY = "ap.theme";

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage may be blocked in private mode — fall through to OS preference
  }
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}

function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#f4f7fb" : "#0b1220";
}

/**
 * Resolves and applies the current theme. Listens to OS preference changes when
 * the user has not explicitly chosen a theme yet (no `ap.theme` in storage).
 */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);
  const explicitlyChosen = useRef(false);
  const [isExplicit, setIsExplicit] = useState(false);

  useEffect(() => {
    applyTheme(theme);
    if (isExplicit) {
      try {
        window.localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // Keep the explicit choice for this session when storage is blocked.
      }
    }
  }, [theme, isExplicit]);

  // Follow OS preference when the user has not explicitly chosen.
  useEffect(() => {
    const mql = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mql) return;
    const onChange = (event: MediaQueryListEvent): void => {
      if (explicitlyChosen.current) return;
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored === "light" || stored === "dark") return;
      } catch {
        // Storage can be blocked while OS preference changes still work.
      }
      setThemeState(event.matches ? "light" : "dark");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    explicitlyChosen.current = true;
    setIsExplicit(true);
    setThemeState(next);
  }, []);
  const toggle = useCallback(() => {
    explicitlyChosen.current = true;
    setIsExplicit(true);
    setThemeState((previous) => previous === "dark" ? "light" : "dark");
  }, []);

  return { theme, setTheme, toggle };
}
