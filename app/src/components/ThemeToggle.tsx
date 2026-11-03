import { useState } from "react";
import { applyTheme, nextTheme, readTheme, type ThemeChoice } from "../lib/theme";

const LABEL: Record<ThemeChoice, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };

/** Cycles system, light, dark. The choice is remembered on this device. */
export function ThemeToggle() {
  const [t, setT] = useState<ThemeChoice>(readTheme);
  const cycle = () => {
    const n = nextTheme(t);
    applyTheme(n);
    setT(n);
  };
  return (
    <button className="theme-toggle" onClick={cycle} data-testid="theme-toggle" data-theme-choice={t}
      aria-label={`${LABEL[t]}. Switch to ${nextTheme(t)}`}>
      {t === "system" ? "Auto" : t === "light" ? "Light" : "Dark"}
    </button>
  );
}
