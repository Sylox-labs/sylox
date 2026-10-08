import { Header } from "@/components/layout/Header";
import { SimpleHero } from "@/components/hero/SimpleHero";
import { ProblemStatement } from "@/components/sections/ProblemStatement";
import { ScoreScale } from "@/components/sections/ScoreScale";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { WhoItsFor } from "@/components/sections/WhoItsFor";
import { Status } from "@/components/sections/Status";
import { Faq } from "@/components/sections/Faq";
import { FinalCtaAndFooter } from "@/components/sections/FinalCtaAndFooter";

export default function Home() {
  return (
    <>
      <Header />
      <div id="top">
        <SimpleHero />
      </div>
      <ProblemStatement />
      <ScoreScale />
      <HowItWorks />
      <Status />
      <WhoItsFor />
      <Faq />
      <FinalCtaAndFooter />
    </>
  );
}
