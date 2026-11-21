import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "VibeCart — Shop by Talking with Zara",
  description: "Voice shopping assistant powered by Agora Conversational AI, Murf Falcon, Deepgram & MCP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
