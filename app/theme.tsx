import { useEffect, useState } from 'react';

// System follows the OS colour scheme; Light and Dark override it. The choice is a
// per-browser preference, applied before paint by the inline script in root.tsx.
const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

export const themeScript = `try{var t=localStorage.getItem('theme');
if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

function apply(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', theme);
  } catch {
    /* Storage can be unavailable (private windows); the choice still applies now. */
  }
}

export function ThemeToggle() {
  // Server render has no access to the stored choice; sync after hydration.
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const stored = document.documentElement.dataset.theme;
    if (stored === 'light' || stored === 'dark') setTheme(stored);
  }, []);
  return (
    <fieldset className="theme-toggle" aria-label="Colour theme">
      {THEMES.map((t) => (
        <button
          type="button"
          key={t}
          aria-pressed={theme === t}
          onClick={() => {
            setTheme(t);
            apply(t);
          }}
        >
          {t.charAt(0).toUpperCase() + t.slice(1)}
        </button>
      ))}
    </fieldset>
  );
}
