import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import './style.css';
import { themeScript } from './theme.tsx';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // The theme attribute is set by the inline script before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
export default function App() {
  return <Outlet />;
}
export function ErrorBoundary() {
  return (
    <main>
      <h1>Dashboard unavailable</h1>
      <p>Check the server logs and database configuration, then refresh.</p>
    </main>
  );
}
