import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ResQ AI · Dispatch console",
  description: "Emergency triage console for ERSS-112",
};

export const viewport: Viewport = {
  // A control-room monitor, not a phone. The console is built for fixed
  // desktop DPI; the layout adapts structurally rather than fluid-scaling.
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
