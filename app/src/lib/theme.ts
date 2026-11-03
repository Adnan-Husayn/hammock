export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "theme";
const ORDER: ThemeChoice[] = ["system", "light", "dark"];

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Sets data-theme on the root so the CSS tokens switch. "system" removes it and follows the OS. */
export function applyTheme(t: ThemeChoice) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch { /* storage blocked: the choice lasts for this page only */ }
}

export const nextTheme = (t: ThemeChoice): ThemeChoice => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length];
