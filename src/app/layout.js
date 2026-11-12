import "./globals.css";

export const metadata = {
  title: "V10 Hypercar Cockpit Simulator",
  description:
    "A controller-only hypercar cockpit simulator featuring a high-refresh instrument cluster, V10-inspired synthesized engine audio, telemetry, exhaust effects and gamepad haptics.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#050507",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
