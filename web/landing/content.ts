// All landing page copy lives here (brief §3 rule 8) so it can be edited
// without touching components. Every non-generic claim carries a `_source`
// pointing at the prd.md / technical-doc.md section it's drawn from, or
// "brief §X" when it's drawn directly from the build brief itself. Claims
// with no `_source` are generic marketing language, not factual claims.

import type { HeroCta } from "@/components/hero/HeroPanel";

interface HeroPanelCopy {
  eyebrow: string;
  heading: string;
  body: string;
  ctas?: HeroCta[];
  _source: string;
}

export const nav = {
  links: [
    { label: "How it works", href: "#how-it-works" },
    { label: "Who it's for", href: "#who-its-for" },
    { label: "Status", href: "#status" },
    { label: "FAQ", href: "#faq" },
  ],
  github: {
    label: "GitHub",
    href: "https://github.com/Sylox-labs",
  },
  cta: "Get early access",
};

export const hero = {
  panels: [
    // satisfies HeroPanelCopy[] below checks each literal (e.g. variant:
    // "primary") against the real component props at the definition site,
    // so every consumer of hero.panels gets properly narrowed types with
    // no local cast — see HeroPanel's HeroCta type.
    {
      eyebrow: "+ RISK INFRASTRUCTURE FOR STELLAR",
      heading: "Know your issuer before it fails.",
      body: "Sylox gives every anchor issued asset on Stellar a public risk score, and a market to protect yourself if the issuer behind it breaks.",
      ctas: [
        { label: "Get early access", href: "#early-access", variant: "primary" },
        { label: "Read the spec", href: "https://github.com/Sylox-labs", variant: "secondary" },
      ],
      _source: "brief §7.2 panel 1",
    },
    {
      eyebrow: "+ 01 / RISK ORACLE",
      heading: "Signals in. One score out.",
      body: "Price against the peg. Liquidity depth. Redemptions. Clawbacks and frozen accounts. Whether the anchor's withdrawals still answer. Sylox combines them into one open score from 0 to 100.",
      _source: "brief §7.2 panel 2; signals per technical-doc.md §5.1, score range per §6.3",
    },
    {
      eyebrow: "+ 02 / CREDIT EVENTS",
      heading: "When the peg breaks, the rules are already written.",
      body: "A depeg or an issuer freeze is defined in public, before anyone buys cover. When the conditions are met, the event is declared. No one decides after the fact.",
      _source: "brief §7.2 panel 3; event definitions per prd.md §6.1, technical-doc.md §4.3/§8.2",
    },
    {
      eyebrow: "+ 03 / PROTECTION MARKETS",
      heading: "Cover pays from collateral that is already locked.",
      body: "Sellers lock USDC. Buyers pay a premium for cover. If a credit event is declared, cover pays out. Every unit of cover is fully backed.",
      _source: "brief §7.2 panel 4; collateral model per prd.md §7",
    },
  ] satisfies HeroPanelCopy[],
};

export const problem = {
  eyebrow: "+ THE PROBLEM",
  heading:
    "One currency. Many issuers. No shared way to see which one is about to fail.",
  bodyLeft:
    "On Stellar, several companies can issue a token for the same currency. Two tokens can share a name and carry very different risk: different reserves, banking partners and track records.",
  bodyRight:
    "Wallets list them side by side. Lenders accept them blind. Holders find out an issuer failed when their withdrawal does. Sylox turns that hidden risk into public data, and gives holders a way to protect themselves.",
  _source: "brief §7.3",
};

export const scoreScale = {
  eyebrow: "+ THE SCORE",
  heading: "Five bands. One glance.",
  sampleLabel: "Illustrative sample, not live data",
  rows: [
    {
      band: "normal",
      range: "0 to 24",
      copy: "Signals are healthy. The peg holds, liquidity is deep, withdrawals answer.",
    },
    {
      band: "watch",
      range: "25 to 49",
      copy: "Something is moving. Worth a closer look before adding exposure.",
    },
    {
      band: "warning",
      range: "50 to 74",
      copy: "Real stress. A lender might lower how much it accepts this asset as collateral.",
    },
    {
      band: "distress",
      range: "75 to 100",
      copy: "Failure signals are stacking up. New cover stops when a failure is already in progress.",
    },
    {
      band: "event",
      range: "Declared",
      copy: "A credit event has been declared under its published rules. Cover pays out.",
    },
  ],
  _source: "brief §7.4; exact ranges per technical-doc.md §6.3",
};

export const howItWorks = {
  eyebrow: "+ HOW IT WORKS",
  heading: "Three parts. One job: make issuer risk visible and protectable.",
  cards: [
    {
      title: "Risk Oracle",
      body: "A public feed with a score for every covered asset. Raw signals are shown next to every score. The formula is open, so anyone can check the math.",
      _source: "brief §7.5 card 1; signals/weights per technical-doc.md §6.1–§6.2",
    },
    {
      title: "Credit Event Registry",
      body: "Failure has a definition before it has a victim. Depegs and issuer freezes are checked against fixed rules, with a challenge window and a named committee for edge cases.",
      _source: "brief §7.5 card 2; challenge window per technical-doc.md §8.1–§8.2",
    },
    {
      title: "Protection Markets",
      body: "One market per asset. Sellers lock USDC and earn premiums. Buyers pay upfront for cover. Payouts come from locked collateral, never from a promise.",
      _source: "brief §7.5 card 3; settlement per prd.md §7.1, §7.5",
    },
  ],
};

export const whoItsFor = {
  eyebrow: "+ WHO IT'S FOR",
  heading: "Built for everyone who holds issuer risk today.",
  rows: [
    {
      word: "WALLETS",
      who: "Wallets",
      body: "Show a risk band next to every issued asset your users hold. Read it straight from the feed.",
    },
    {
      word: "LENDERS",
      who: "Lending protocols",
      body: "Adjust collateral limits from live risk bands instead of guessing per issuer.",
    },
    {
      word: "ANCHORS",
      who: "Anchors",
      body: "Prove you are safe with public signals anyone can verify, and a right to reply on your page.",
    },
    {
      word: "HOLDERS",
      who: "Treasuries, NGOs, fintechs, market makers",
      body: "Buy cover on the assets you hold, or lock collateral and earn premiums by writing it.",
    },
  ],
  _source: "brief §7.6; priority order per prd.md §9",
};

export const status = {
  eyebrow: "+ STATUS",
  heading: "Where we are.",
  body: "Sylox is in development. Here is the honest state of things.",
  items: [
    { label: "Protocol specification", tag: "PUBLISHED" },
    { label: "Risk Oracle contract", tag: "IN DEVELOPMENT" },
    {
      label: "Credit Event Registry and Protection Markets contracts",
      tag: "NEXT",
    },
    { label: "Testnet with real mainnet data", tag: "PLANNED" },
    { label: "Security audit", tag: "BEFORE MAINNET" },
    { label: "Protection markets on mainnet", tag: "AFTER LEGAL REVIEW" },
  ],
  _source: "brief §7.9; roadmap per prd.md §15.2",
};

export const faq = {
  eyebrow: "+ FAQ",
  items: [
    {
      question: "Is this insurance?",
      answer:
        "No. Sylox is a protocol for fully collateralized protection. Every unit of cover is backed by collateral that sellers have already locked. Protection markets will only launch where legal review allows.",
    },
    {
      question: "Who decides if an issuer failed?",
      answer:
        "The rules do. Each credit event has a published definition, checked against public data, with a challenge window. A named committee handles only the edge cases, and its reasons are published.",
    },
    {
      question: "Is the score a credit rating?",
      answer:
        "No. It is computed from public data with an open formula. The raw signals are shown next to every score, so you can see exactly why it is what it is.",
    },
    {
      question: "Is it audited?",
      answer: "Not yet. The contracts will be audited before anything runs on mainnet.",
    },
    {
      question: "Do I need to hold the asset to buy cover?",
      answer:
        "That is still being decided, partly through legal review. We will publish the rule before markets open.",
    },
    {
      question: "Can I use the risk feed in my wallet or protocol?",
      answer:
        "That is the point of it. If you want to be an early reader of the feed, join the early access list and tell us what you are building.",
    },
  ],
  _source: "brief §7.10",
};

export const openSource = {
  eyebrow: "+ OPEN BY DEFAULT",
  heading: "Built on Stellar. Built in the open.",
  items: [
    {
      title: "Soroban contracts",
      body: "The rules live in smart contracts on Stellar, not on our servers.",
    },
    {
      title: "Open formula",
      body: "The scoring formula and event definitions are public. Anyone can recompute a score.",
    },
    {
      title: "Apache 2.0",
      body: "The code is open source. Read it, fork it, build on it.",
    },
  ],
  link: { label: "View the code on GitHub", href: "https://github.com/Sylox-labs" },
  _source: "brief §7.8; license per prd.md §17.3",
};

export const finalCta = {
  heading: "Security infrastructure for a fragmented world.",
  body: "Get early access to the feed, the testnet, and the first protection markets.",
  roles: [
    "Wallet",
    "Lending protocol",
    "Anchor",
    "Treasury or fintech",
    "Market maker",
    "Other",
  ],
  submitLabel: "Get early access",
  _source: "brief §7.11",
};

export const footer = {
  tagline: "Built for what's next.",
  links: {
    github: "https://github.com/Sylox-labs",
    x: "#",
    contact: "mailto:hello@sylox.xyz",
  },
  builtOnStellar: "Built on Stellar",
};
