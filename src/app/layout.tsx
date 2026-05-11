import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "braid-studio",
  description: "Granular video creation for marketers.",
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen">{children}</body>
    </html>
  );
}
