import type { Metadata } from "next";
import { inter, spaceMono, bigShoulders } from "@sylox/ui/fonts";
import { WalletProvider } from "@/lib/wallet/WalletContext";
import "@sylox/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sylox App",
  description: "Testnet. See an issuer's risk, provide cover, buy cover, and claim.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${inter.variable} ${spaceMono.variable} ${bigShoulders.variable} h-full`}
    >
      <body className="flex min-h-full flex-col bg-slate-black text-silo-oatmeal antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
