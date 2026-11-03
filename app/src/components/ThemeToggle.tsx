import { useState } from "react";
import { applyTheme, nextTheme, readTheme, type ThemeChoice } from "../lib/theme";

const TEXT: Record<ThemeChoice, string> = { system: "Theme: Auto", light: "Theme: Light", dark: "Theme: Dark" };

function Icon({ t }: { t: ThemeChoice }) {
  const p = { width: 12, height: 12, viewBox: "0 0 16 16", "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: 1.6 } as const;
  if (t === "light") return <svg {...p}><circle cx="8" cy="8" r="3" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" /></svg>;
  if (t === "dark") return <svg {...p}><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" /></svg>;
  return <svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 2a6 6 0 0 1 0 12Z" fill="currentColor" /></svg>;
}

/** A quiet utility that cycles Auto, Light and Dark. The choice is remembered on this device. */
export function ThemeToggle() {
  const [t, setT] = useState<ThemeChoice>(readTheme);
  const cycle = () => {
    const n = nextTheme(t);
    applyTheme(n);
    setT(n);
  };
  return (
    <button className="theme-toggle" onClick={cycle} data-testid="theme-toggle" data-theme-choice={t}
      aria-label={`${TEXT[t]}. Switch to ${TEXT[nextTheme(t)].replace("Theme: ", "")}`}>
      <Icon t={t} /> {TEXT[t]}
    </button>
  );
}
