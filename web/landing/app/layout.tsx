import type { Metadata } from "next";
import { inter, spaceMono, bigShoulders } from "./fonts";
import { MotionBootstrap } from "@/lib/motion/MotionBootstrap";
import "./tokens.css";
import "./globals.css";

const siteUrl = "https://sylox.xyz";
const description =
  "Sylox gives every anchor issued asset on Stellar a public risk score, and a market to protect yourself if the issuer behind it breaks. In development on Soroban.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Sylox — Risk infrastructure for Stellar",
  description,
  openGraph: {
    title: "Sylox — Risk infrastructure for Stellar",
    description,
    url: siteUrl,
    siteName: "Sylox",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sylox — Risk infrastructure for Stellar",
    description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceMono.variable} ${bigShoulders.variable}`}
    >
      <body>
        <MotionBootstrap />
        {children}
      </body>
    </html>
  );
}
