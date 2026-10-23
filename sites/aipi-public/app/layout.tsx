import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "AIPI — Trusted context and compatible releases", template: "%s · AIPI" },
  description: "AIPI traces API changes across repositories, separates code facts from untrusted claims, and checks exact backend/frontend version pairs. Context trust and release gates are being hardened.",
  icons: { icon: "/aipi-logo.svg", shortcut: "/aipi-logo.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: `(function(){try{var saved=localStorage.getItem('aipi-theme');var theme=saved==='light'||saved==='dark'?saved:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme}catch(e){}})();` }} /></head><body>{children}</body></html>;
}
