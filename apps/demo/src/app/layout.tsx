import Link from "next/link";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/providers/trpc-provider";

export const metadata = { title: "trpc-lens demo" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 24 }}>
        <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
          <Link href="/">Home</Link>
          <Link href="/server-direct">Server direct</Link>
          <Link href="/server-prefetch">Server prefetch</Link>
          <Link href="/client">Client</Link>
        </nav>
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
