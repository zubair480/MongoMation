# MongoMation: industry pain point research pack

Prepared 2026-10-11 for the MongoMation hackathon team. The judges are technical (MongoDB, AWS, AI tooling) but are not industrial-automation experts.

MongoMation turns a plain-English machine spec into a tested IEC 61131-3 PLC program. It validates the program on a 3D factory simulation (Factory I/O + OpenPLC), injects faults (jams, stuck or failed sensors, machine error signals), then diagnoses and repairs the logic. It also learns from earlier runs.

---

## 0. How to read this pack

### 0.1 Evidence labels (every number carries one)

| Label | Meaning | How to use on a slide |
|---|---|---|
| **[IND]** | Independent: government or regulator (HSE, CSB, GAO, NIST, BLS) or a peer-reviewed or academic source | Safe to state as fact, with the citation |
| **[ASSOC]** | Industry association, consultancy or trade-media survey (Deloitte/Manufacturing Institute, PMMI, ARC/ISA, Control Engineering) | Safe, attributed ("according to Deloitte…") |
| **[VEND]** | A vendor's own survey or research report (Siemens, ABB, Fluke, Copia, MachineMetrics) | Attribute it, and say it is the vendor's survey |
| **[VEND-CASE]** | A vendor case study or marketing claim, usually best-case | Use as "for example…", never as typical |
| **[MKT]** | Market-research-firm estimate (low credibility, inconsistent) | Avoid, or give only a rough order of magnitude |
| **[EST]** | Our own back-of-envelope arithmetic from cited inputs | Show the assumptions |
| **[UNVERIFIED]** | Appears only in secondary sources; the primary was not found | Don't put on a slide |

### 0.2 Verification method and its limits (read this before quoting)

- **Network policy blocked direct fetches** from this environment, including arxiv.org, siemens.com, hse.gov.uk and csb.gov.
- **Search-engine extracts only.** Every figure was gathered from search-engine extracts of the cited page and cross-checked against a second source where possible.
- **Primary PDFs not opened.** We did not open the primary PDFs, including the Siemens TCOD 2024 report, the ABB report, the HSE HSG238 book and arXiv papers.
- **Before a number goes on a slide,** open the URL and copy the exact sentence.
- **Known discrepancies** are flagged inline. Examples: LLM4PLC's expert scores differ between the arXiv and ICSE versions, and Heathrow T5 bag counts vary by cut-off date.

### 0.3 Mini-glossary for non-industrial judges

- **PLC.** A programmable logic controller is the rugged industrial computer that runs a machine. Its I/O is sensors in and motors and valves out. It runs a scan loop every few milliseconds.
- **IEC 61131-3.** The international standard for PLC languages: Structured Text (ST), Ladder (LD), Function Block Diagram (FBD) and Sequential Function Chart (SFC). OpenPLC runs it, and so do CODESYS and Beckhoff. Siemens SCL is an ST dialect.
- **Commissioning.** Installing the machine, loading the PLC program and debugging it on site until production runs. It sits on the critical path of a project.
- **Virtual commissioning (VC).** Running the real PLC program against a simulated plant (a "digital twin") before the hardware exists, to find bugs early.
- **OEE.** Overall Equipment Effectiveness, the product of availability, performance and quality. 100% means perfect production.

---

## 1. Executive summary: the pain point in one paragraph

Unplanned downtime costs the world's 500 largest companies about **$1.4 trillion a year (11% of revenue)**. An idle automotive line costs about **$2.3M per hour** (Siemens TCOD 2024 [VEND]).

The UK safety regulator analysed real control-system failures. It found that **44% trace back to inadequate specification**, 15% to design and implementation, and **20% to changes made after commissioning** (HSE HSG238 [IND]). Bad specs, bad logic and unsafe changes, the exact chain MongoMation targets, account for the large majority of failures.

The people who write and debug this logic are scarce:

- **1.9M of 3.8M** needed US manufacturing jobs could go unfilled by 2033 (Deloitte & MI [ASSOC]).
- **95% of CPG companies** struggle to hire skilled technicians (PMMI 2025 [ASSOC]).

PLC code is still mostly tested by hand, on site, at the end of the project:

- Commissioning takes **15–20% of an automation project's delivery time**.
- About **two-thirds of commissioning time goes to fixing control-software errors** ([VEND] blog plus an academic thesis; primary study not traced).

Virtual commissioning is the known fix. Vendor case studies typically report **20–50% less commissioning time, ~70% at best**, and **~95% of errors found before go-live** [VEND-CASE]. Yet only **"just over half" of surveyed firms use VC at all, and then "rarely to occasionally"**. Automated testing shows up only at large companies (FAU survey 2023 [IND]), because building and maintaining simulation models and tests is expensive.

LLMs alone don't solve it: "GPT-4 and LLaMa2 fail to produce valid programs" for PLC-controlled systems (LLM4PLC, ICSE-SEIP 2024 [IND]).

**MongoMation's honest pitch:** close the loop that the industry knows works (simulate, inject faults, fix) and make it cheap, automatic and self-improving.

---

## 2. Cost of unplanned downtime

### 2.1 Headline numbers

| # | Finding | Source (publisher, date) | Label |
|---|---|---|---|
| 1 | Unplanned downtime costs the world's **500 biggest companies ~$1.4 trillion/year, 11% of revenues** | Siemens, *The True Cost of Downtime 2024*, [PDF](https://assets.new.siemens.com/siemens/assets/api/uuid:1b43afb5-2d07-47f7-9eb7-893fe7d0bc59/TCOD-2024_original.pdf); summary by [AEMT, 1 Aug 2024](https://www.theaemt.com/resource/the-true-cost-of-downtime-2024-a-comprehensive-analysis.html) | [VEND] |
| 2 | Up from **$864B (8% of revenue)** in the 2021 edition (2019–20 data) | Senseye/Siemens via [Automation.com, Jun 2021](https://www.automation.com/article/world-largest-manufacturers-lose-almost-1-trillion) | [VEND] |
| 3 | Average large plant loses **27 hours/month** to unplanned downtime (39 in 2019), across **~25 incidents/month** (42 in 2019) | Siemens TCOD 2024 (above); also [ISM, Aug 2024](https://www.ismworld.org/supply-management-news-and-reports/news-publications/inside-supply-management-magazine/blog/2024/2024-08/the-monthly-metric-unscheduled-downtime/) | [VEND] |
| 4 | **Method caveat:** 181 online interviews with maintenance, engineering and IT staff at large firms in 4 sectors. Siemens says year-on-year figures are "indicative only" | Siemens TCOD 2024 | [VEND] |
| 5 | **Over two-thirds (69%)** of plants have unplanned outages **at least monthly**. Typical cost is **~$125,000/hour** (median $124,669). 21% still run equipment to failure. Survey of 3,215 maintenance leaders by Sapio Research, July 2023 | ABB, *Value of Reliability* [press release, Oct 2023](https://new.abb.com/news/detail/107660/abb-survey-reveals-unplanned-downtime-costs-125000-per-hour); [report PDF](https://new.abb.com/docs/librariesprovider19/default-document-library/abb_survey-report-2023.pdf) | [VEND] |
| 6 | US typical cost **~$103,000/hour** (same ABB survey) | [Automation.com, Oct 2023](https://www.automation.com/en-us/articles/october-2023/abb-survey-unplanned-downtime-costs-per-hour) | [VEND] |
| 7 | **61%** of manufacturers had unplanned downtime in the past year, and **48% report 6–10 downtime incidents per week**. The sector-wide cost is modelled at "up to $852M per week". Censuswide, n=600, F&B, O&G, life sciences and automotive, in DE, UK and US | [Fluke Reliability, 30 Oct 2025](https://reliability.fluke.com/unplanned-downtime-costs-manufacturers-up-to-852m-weekly/) | [VEND] (modelled) |
| 8 | "$260,000/hour average" (Aberdeen, ~2016) is widely repeated, but we could not find the original report | e.g. [Reliamag](https://reliamag.com/articles/cost-unplanned-downtime-manufacturing/) | [UNVERIFIED] |

### 2.2 Cost per hour by sector

| Sector | Figure | Source | Label |
|---|---|---|---|
| **Automotive** | **$2.3M per hour** for an idle line (≈ $640/second). **$695M/year** per idle production line at a big plant, 1.5× five years earlier | Siemens TCOD 2024 ([PDF](https://assets.new.siemens.com/siemens/assets/api/uuid:1b43afb5-2d07-47f7-9eb7-893fe7d0bc59/TCOD-2024_original.pdf); [AEMT summary](https://www.theaemt.com/resource/the-true-cost-of-downtime-2024-a-comprehensive-analysis.html)) | [VEND] |
| **Heavy industry** | **$59M/year per plant**, 1.6× 2019. This is an annual figure, though some blogs misquote it as hourly | Siemens TCOD 2024 | [VEND] |
| **FMCG / consumer goods (packaging-heavy)** | **~$36,000 per lost hour**, which Siemens calls "the low end". FMCG costs have been "stable" | Siemens TCOD 2024 | [VEND] |
| **Food & beverage** | **$4,000–$30,000/hour**. **Up to 12 hours lost** in a single incident if clean-up is required. This is an ABB estimate relayed by a journalist | [Manufacturing Digital, 2023](https://manufacturingdigital.com/procurement-and-supply-chain/unscheduled-downtime-costs-us-125-000-per-hour-abb-survey) | [VEND] |
| **Packaging / F&B (older)** | **46% of companies lose >$10,000/hour**. F&B estimated at $5k–$10k/hour | Thomson Industries survey (2012), republished in Videojet white paper [PDF](https://global.videojet.com/wp-content/uploads/dam/pdf/NA%20-%20English/White-Paper/wp-driving-oee-and-uptime-on-packaging-lines-us.pdf) | [VEND], dated |
| **"Code-related" shutdowns (self-reported)** | Coding-error shutdowns last **~30 hours**, cost **$4.2M/hour**, **$126M per shutdown**. Survey of 200 US execs; treat as a perception, high end | Copia Automation, *State of Industrial DevOps 2024*, [press release, 9 Jul 2024](https://www.copia.io/blog/press-release-the-state-of-industrial-devops); [Automation World](https://automationworld.com/factory/plant-maintenance/news/55130884/two-factors-lead-manufacturers-to-lose-126-million-per-shutdown) | [VEND] |

### 2.3 Which share of downtime comes from sensors, jams and control logic?

**No authoritative cross-industry breakdown of downtime by "sensor vs. jam vs. control-logic" cause exists.** We searched Siemens, ABB, Fluke, ISA/ARC, PMMI and academic sources. Say this honestly if asked. The best available evidence for each cause is below.

#### Control logic, specification and software

- **UK HSE, *Out of Control* (HSG238, 2nd ed. 2003)** [IND] studied 34 control-system incidents ([hse.gov.uk](https://www.hse.gov.uk/PUBNS/books/hsg238.htm)). Primary causes:
  - **44% inadequate specification**
  - **15% design & implementation**
  - **6% installation & commissioning**
  - **15% operation & maintenance**
  - **20% changes after commissioning**

  Commentators summarise it as ~3/5 of failures being "built in before operation commences". The incident analysis dates from the 1995 first edition, and HSE says the findings still apply. **This is the single most powerful independent statistic for MongoMation:** a better spec feeds a tested implementation, and every change gets re-tested.
- **Copia 2025** (vendor survey, 200 senior industrial leaders): **industrial code accounts for 45% of all downtime**, rising to 66% at companies with more than $15B revenue. **Executives say 52%; plant managers say 30%.** Use 30% as the conservative figure. Average downtime cost is $3.63M/hour ([Copia report page](https://www.copia.io/resources/the-2nd-annual-state-of-industrial-devops-report); [Automation Magazine](https://www.automationmagazine.co.uk/new-copia-automation-report-reveals-4-29m-hour-downtime-cost-for-c-suite-exposing-critical-perception-gap-with-plant-floor/)). [VEND]. Copia sells PLC source control, so it has an interest in these numbers.
- **Copia 2024**: ~50% of downtime is attributed to "industrial code changes, code confusion, lack of visibility into code, and PLC issues" combined. In the cause ranking, coding errors scored 41%, behind cybersecurity (47%) and hardware (45%). **79% say ad hoc fixes to industrial programming are common** ([DevClass, 9 Jul 2024](https://www.devclass.com/ci-cd/2024/07/09/daunting-downtime-stats-help-put-industrial-devops-under-spotlight/1627670)). [VEND]
- **Farooqui, Bergagård, Falkman, Fabian (Chalmers), IEEE ETFA 2016** surveyed the Swedish automotive industry ([record](https://research.chalmers.se/en/publication/243444)). It found **error-handling procedures integrated "towards the end of physically building the manufacturing line"**, "lack of a defined workflow", **"untested program logic"** and "inadequately equipped personnel". [IND]
- **AAAI SIGMAN workshop, 1998:** in real ladder programs, **under 20% of the code executes the actual process plan**. **20–40% is diagnostics**, and the rest is operator interface and information systems ([PDF](https://cdn.aaai.org/SIGMAN/1998/SIGMAN98-028.pdf)). [IND, dated] Pitch use: the "happy path" is the easy part, and fault handling is most of the real work. That is what fault injection exercises.

#### Sensors

- **Process-industry safety-system failure data (OREDA / exida):** ~**92% of failures occur in field devices**, with **sensors ~42%** and final elements such as valves ~50%. Only **~8% occur in the logic solver** (the controller). Sources: [Emerson Automation Experts](https://www.emersonautomationexperts.com/?p=44037); [Automation World, "SIS in Field Instrumentation"](https://www.automationworld.com/products/control/blog/13307926/sis-in-field-instrumentation). [IND data via vendor and trade articles]
  - Pitch use: the controller rarely breaks; the sensors and actuators do. Logic must therefore detect implausible sensor values (stuck, frozen, flickering) and fail safe.
- No credible figure for "% of discrete-manufacturing downtime caused by sensor faults" was found. Vendor blogs quote 28–35% for micro-stops, which we rate [UNVERIFIED].
- See the incident stories in §7: Buncefield, Texas City and Milford Haven were all sensor or indication failures.

#### Jams and material flow

- **Assembly Magazine** (industry commentary, n.d.) says **part-feeding jams are the most common reason for downtime in automated assembly systems** ([article](https://assemblymag.com/articles/85241-station-to-station-buffers-maximize-uptime-in-automated-assembly)). Its worked example:
  - 50 assemblies/min with 5 parts each.
  - Only **5 jams per 10,000 parts (99.95% good)** makes the system **stop every ~8 minutes**.
  - With 2-minute restarts, the system is **down 20% of the time**.
  - A 30-station synchronous line can end up at **60–70% efficiency even if each station is 99% efficient**.
- **Boothroyd DFMA guidance:** default planning assumptions of **~2 in 1,000 parts defective and causing a stoppage, ~30 s downtime each**. The usual 85% plant-efficiency figure *excludes* these jam stoppages ([DFMA PDF](https://www.dfma.com/support/Downloads/AutomaticAssembly.pdf)). [IND, textbook/tool guidance]
- **US GAO, 1994, on the Denver airport baggage system:** "bags being misloaded, misrouted, or falling out of telecarts, causing the system to jam" ([GAO RCED-95-35BR](https://www.gao.gov/products/rced-95-35br)). [IND] See §7.
- **PMMI Business Intelligence**, *Packaging & Predictive Maintenance* (2021): CPG managers rate **packaging machines as more downtime-prone than their other machine types**. Named causes include general wear and tear, operator error and product changeover ([Packaging World, 2021](https://www.packworld.com/issues/business-intelligence/article/21307820/predictive-maintenance-pain-points-in-packaging-machinery); [Processing, Apr 2023](https://digital.processingmagazine.com/processing-april-2023/page-12)). [ASSOC]
  - One search extract showed wear and tear 26.3%, product changeover 22.1% and operator error 21.1%, but we could not confirm this. [UNVERIFIED]

#### When downtime happens

- **ARC Advisory / ISA survey (2019):** most unplanned downtime occurs while the plant is in a **transitional state, such as startup or grade changes** ([ARC](https://www.arcweb.com/blog/process-industry-downtime-and-key-performance-metrics); [ISA InTech](https://www.isa.org/intech-home/2019/march-april/features/key-performance-metrics-and-indicators-survey-high)). [ASSOC]
- Pitch use: changeovers and restarts exercise rarely tested logic paths, which is where generated tests and fault injection pay off.

### 2.4 Back-of-envelope (label [EST])

- **Per plant:** an FMCG/packaging plant at the *low-end* $36,000/hour (Siemens) × 27 hours/month (Siemens average) is roughly **$0.97M per month** of unplanned downtime.
- **Code-related share:** if the conservative 30% (plant managers' view, Copia 2025) is code or logic-related, that is about **$290k per plant per month**.
- **Caveat:** this combines a vendor's average-hours figure with a vendor survey's cause share. Present it as illustrative only.

---

## 3. The controls-engineering bottleneck

### 3.1 Not enough people

| Finding | Source | Label |
|---|---|---|
| US manufacturing needs up to **3.8M new workers (2024–2033)**, and **1.9M could go unfilled**. **65%** say attracting and retaining talent is their primary business challenge (a NAM Q1 2024 survey figure cited in the release) | Deloitte & The Manufacturing Institute, *Taking charge* ([Deloitte press release, 3 Apr 2024](https://www2.deloitte.com/us/en/pages/about-deloitte/articles/press-releases/us-manufacturing-could-need-new-employees-by-2033.html); [MI](https://themanufacturinginstitute.org/manufacturers-need-as-many-as-3-8-million-new-employees-by-2033/)) | [ASSOC] |
| Five years of job-posting data show a **75% jump in demand for simulation and simulation-software skills**, mostly for technology-enabled production and testing roles | Same study via [Manufacturing Dive, Apr 2024](https://www.manufacturingdive.com/news/manufacturing-labor-shortage-2033-deloitte-mi-report-2024/713133/) | [ASSOC] |
| Earlier edition: **2.1M unfilled jobs by 2030**, potentially costing **$1 trillion in 2030 alone**. Finding the right talent is **36% harder than in 2018** | Deloitte & MI 2021 ([NAM](https://www.nam.org/2-1-million-manufacturing-jobs-could-go-unfilled-by-2030-13743/); [MI](https://themanufacturinginstitute.org/2-1-million-manufacturing-jobs-could-go-unfilled-by-2030-11330)) | [ASSOC] |
| **95% of CPG companies** struggle to hire skilled operators and technicians, and **~60%** expect it to get harder. Drivers: retirements of experienced staff, turnover, competition for technical talent | PMMI, *Inside the Workforce Gap* (2025) via [Processing](https://processingmagazine.com/news-notes/news/55337926/pmmi-report-finds-manufacturers-expect-hiring-challenges-to-intensify) | [ASSOC] |
| Threat of worker shortages cited by **57% (2022), 48% (2023)**. In 2025 it **tied for #1 business challenge at 38%** | Control Engineering Career & Salary Surveys ([2023](https://www.controleng.com/control-engineering-career-and-salary-survey-2023/); [2025](https://www.controleng.com/results-are-in-control-engineering-career-and-salary-survey-2025/)) | [ASSOC], media survey |
| Recruiter view: "a shortage of qualified controls and automation engineers, entry level or seasoned, certainly exists" | [Control Engineering](https://www.controleng.com/next-generation-control-engineer-advice) | qualitative |
| BLS has no "controls engineer" category. The nearest proxy, industrial engineers, grows **+11% (2024–34), ~25,200 openings/yr** | [BLS OOH](https://www.bls.gov/ooh/architecture-and-engineering/industrial-engineers.htm) | [IND] |

**Honesty note:** there is **no authoritative headcount of the "controls engineer shortage"**. Use the Deloitte, PMMI and Control Engineering figures, which cover skilled manufacturing and technical roles broadly, and say so.

### 3.2 Where engineering time goes

- **Commissioning is 15–20% of the total delivery time** of an automation project. **"Nearly 2/3 of the time spent in commissioning is spent on fixing software errors"**, because control software only gets proper integration testing after the hardware is assembled. Source: [Visual Components blog](https://www.visualcomponents.com/blog/increasing-control-software-quality-with-virtual-commissioning/) (n.d.). [VEND] The blog footnotes this claim, and we could not retrieve the footnote.
  - **Corroboration:** a University of Augsburg thesis on VC with Bosch Rexroth controllers says **up to 70% of the time needed to commission the control technology is spent finding and fixing software errors** (our translation of "bis zu 70% der Zeit, die für die Inbetriebnahme der Steuerungstechnik benötigt wird, für das Finden und Beheben von Softwarefehlern") ([PDF](https://opus.bibliothek.uni-augsburg.de/opus4/frontdoor/deliver/index/docId/51885/file/51885.pdf)). [IND thesis; it gives no survey of its own]
  - **Corroboration:** Hofmann, Schweig & Mikelsons (Bosch Rexroth / U. Duisburg-Essen, Mechatronik 2015) state that fixing control-application errors is the dominant commissioning effort (qualitative).
  - **[EST]:** 15–20% × 2/3 ≈ **10–13% of an automation project's schedule is on-site software bug-fixing, on the critical path**.
- **Automation is only 2–5% of a capital project's cost but historically ~30% of project risk** ([Control Global](https://www.controlglobal.com/manage/optimization/article/11319767/flex-investments-take-aim-at-engineering-costs); Emerson says ~4% of investment, [ARC](https://www.arcweb.com/node/35536)). [ASSOC/VEND]
- **Manufacturers lose an average of 45 hours per month debugging code**, and **47% still manage industrial code in Excel**. Source: Copia, *State of Industrial DevOps Workforce 2025* ([page](https://www.copia.io/resources/the-state-of-industrial-devops-workforce-2025)). [VEND]
- **Nearly half of engineers spend at least a quarter of their work week on manual, repetitive tasks** ([Siemens](https://resources.sw.siemens.com/en-US/automated-plc-code-generation-engineering/)). [VEND; survey not named]
- **PLC programming error rates in experiments are usually in the double-digit percent range**, and automation debugging cannot be done at the desk; it has to happen on site. Source: Duschl, Gramß, Obermeier, Vogel-Heuser, *Cognition, Technology & Work* 17(3), 2015, citing Braun 2013 and Hajarnavis & Young 2008 ([Springer](https://link.springer.com/article/10.1007/s10111-014-0307-x)). [IND]

### 3.3 Bugs found late cost far more

- **Fagan (IBM, 1976):** errors found in system test cost **~10× more** to fix than during construction, and **10–25× more** after release ([summary](https://ifsq.org/work-fagan-1976.html)). [IND, classic]
- **Siemens VC guidance:** undetected errors' costs "grow by a factor of ten per phase of development" (the "rule of ten") ([Siemens](https://siemens.com/in/en/products/automation/industry-software/automation-software/tia-portal/virtual-commissioning.html)). [VEND]
- **NIST/RTI (2002):** inadequate software-testing infrastructure costs the US **$22.2–59.5B/year**. **Over half of bugs are not found until "downstream"** ([NIST summary](https://www.nist.gov/document/samate-document-greg-tasseys-summary-pdf-nists-2002-report-economic-impacts-inadequate)). [IND]
- **Concrete PLC example:** Daifuku Webb (airport and baggage intralogistics) tests PLC code in-house in a virtual environment. This cut its engineers' **field time on an airport project from several months to about three weeks** ([Rockwell blog, 2020](https://www.rockwellautomation.com/pt-pt/company/news/blogs/avoid-costly--last-minute-surprises-with-virtual-commissioning.html); English copies exist on other Rockwell locales). [VEND-CASE]

### 3.4 Control programs keep changing, and every change is a re-commissioning risk

- **HSE:** **20% of control-system failures come from changes after commissioning** ([HSG238](https://www.hse.gov.uk/PUBNS/books/hsg238.htm)). [IND]
- **Copia 2024:** **79%** say ad hoc fixes to industrial programming are common. [VEND]
- **PMMI 2019 trends report coverage:** a Rockwell executive quoted in the coverage describes an "explosion in SKUs". Long production runs have largely disappeared, and machines must change over easily between package sizes and materials ([Packaging World](https://www.packworld.com/home/article/21114595/balancing-production-optimization-in-a-changing-world)). [ASSOC]
- **McKinsey case:** at one consumer company, SKU proliferation cut **sales per SKU by 40% in three years**. A 25% SKU cut **sped up changeovers** and lifted gross margin 2–4 points ([McKinsey](https://www.mckinsey.com/industries/consumer-packaged-goods/our-insights/simpler-is-sometimes-better-managing-complexity-in-consumer-goods)). [ASSOC]
- **Brownfield re-commissioning:** a volume upgrade on an existing engine assembly line took **3 months with VC, versus the 6–8 months** Siemens says it "could have been" ([Siemens case: Wipro PARI](https://resources.sw.siemens.com/en-US/case-study-wipro-pari)). [VEND-CASE; the 6–8 months is a counterfactual]
- **ARC/ISA:** downtime concentrates in **transitional states (startups, grade changes)**. [ASSOC]

### 3.5 PLC testing is still mostly manual, and that is the gap MongoMation automates

- **RWTH Aachen research:** testing of industrial automation software has so far been done manually, which is expensive and not very thorough (paraphrase) ([PDF](https://www-i2.moves.rwth-aachen.de/i2/pdfs/1023.pdf)). [IND]
- **Kunz, Weber, Barth, Franke (FAU Erlangen), ASIM 2023 industry survey:** **test automation is only found in large companies**. Obstacles are the effort to create and maintain tests, plus missing know-how ([record](https://cris.fau.de/publications/310833827); [PDF](https://www.db-thueringen.de/servlets/MCRFileNodeServlet/dbt_derivate_00061299/ilm1-2023100033_241-250.pdf)). [IND]
- **Mälardalen industrial study (2016, IEC 61131-3 train-control software):** automatically generated test suites reach **similar code coverage to manual suites "in a fraction of the time"** ([MDU](https://www.es.mdu.se/publications/4576-An_Industrial_Study_on_Automated_Test_Generation_and_Manual_Testing_of_IEC_61131_3_Software)). [IND]
- **Prior art to acknowledge:**
  - TUM's fault-injection testing of PLC software in production systems: Rösch et al., IFAC 2014 ([PDF](https://skoge.folk.ntnu.no/prost/proceedings/ifac2014/media/files/1238.pdf)).
  - "A light-weight fault injection approach to test automated production system PLC software in industrial practice", *Control Engineering Practice* 58 (2017) ([TUM](https://portal.fis.tum.de/en/publications/a-light-weight-fault-injection-approach-to-test-automated-product/)). Its tests run against a simulation or the real plant. [IND]
  - **So fault injection itself is not new.** The new part is combining it with LLM generation, automatic repair and learning.

---

## 4. Virtual commissioning (VC): evidence, adoption, market

### 4.1 What it is, for judges

You connect the *real* PLC program (or a soft-PLC running it) to a simulated machine. The simulated sensors feed the PLC, and the PLC's outputs move simulated conveyors, robots and valves. You can then find logic bugs and test fault reactions such as "tray full" or "read error" ([SimPlan](https://www.simplan.de/en/services/virtual-commissioning-high-level-emulation/)) before steel is cut. The test work moves off the project's critical path. **MongoMation = VC + automatic test generation + fault injection + automatic repair + memory.**

### 4.2 Measured results: named case studies

All of these are vendor-published and best-case; label them [VEND-CASE].

| Case | Sector | Tooling | Reported result | Source |
|---|---|---|---|---|
| **Ferrero** high-bay warehouse | Intralogistics / food | Siemens Plant Simulation | **30% less commissioning time** (the stated goal). **~95% of errors detected before the "hot phase"** (go-live). Target availability of 98% reached in **3 weeks instead of the usual 6 months (−88%)** | [Siemens case study](https://resources.sw.siemens.com/en-US/case-study-ferrero) |
| **Bastian Solutions** for a global fashion brand | Warehouse / intralogistics | Rockwell Emulate3D, mapped to raw PLC I/O | **18% less total project time**, including **~5 weeks less on-site commissioning**. The physics engine found a spot where **slightly bigger boxes could cause a mechanical jam**, fixed by moving a section a couple of feet | [Rockwell case study](https://www.rockwellautomation.com/en-us/company/news/case-studies/warehouse-design-digital.html) |
| **Daifuku Webb** airport project | Airport baggage / intralogistics | Rockwell emulation | Engineers' field time cut **from several months to ~3 weeks** | [Rockwell blog, 2020](https://www.rockwellautomation.com/pt-pt/company/news/blogs/avoid-costly--last-minute-surprises-with-virtual-commissioning.html) |
| **Bottling line** (unnamed clients) | Beverage packaging | Rockwell emulation | On-site controls commissioning **from 3 weeks to 4 days**. Rockwell calls this scale of reduction "typical" | [Rockwell blog](https://www.rockwellautomation.com/en-be/company/news/blogs/add-emulation-to-your-speed-to-market-toolbox.html) |
| **Wipro PARI** brownfield engine assembly line (automotive) | Automotive | Siemens Process Simulate + SIMIT, PLC/HMI hardware-in-the-loop | **On-site commissioning time −70%**. Design to shop floor in 3 months vs. a "6–8-month job" | [Siemens case study](https://resources.sw.siemens.com/en-US/case-study-wipro-pari); [blog](https://blogs.sw.siemens.com/tecnomatix/wipro-pari-reduces-commissioning-time-by-70/) |
| **TMS Turnkey Manufacturing Solutions**, car-body and truck-cab lines | Automotive body shop | Siemens Tecnomatix (Plant Simulation, Process Simulate, NX) | Final on-site commissioning **"from several weeks to a few days"** | [Siemens case study](https://resources.sw.siemens.com/en-US/case-study-tms-tecnomatix/); [blog](https://blogs.sw.siemens.com/tecnomatix/turnkey-manufacturing-solutions-customer-success-story/) |
| **MINO**, body-in-white welding lines (China) | Automotive body shop | Siemens Tecnomatix | **Project cycles −20–30%** | [Siemens blog](https://blogs.sw.siemens.com/tecnomatix/automotive-equipment-supplier-saves-time-with-tecnomatix-virtual-commissioning-solutions/) |
| **Estun Automation**, battery and PV lines | Machine builder | Siemens Process Simulate | **On-site commissioning −30%**, overall commissioning cost **−20%** | [Siemens blog, Jan 2024](https://blogs.sw.siemens.com/tecnomatix/estun-automation-reduces-shopfloor-commissioning-time-by-30/) |
| **Hugo Beck**, e-commerce paper packaging machine | Packaging machinery | Siemens digital twin | Commissioning time **~−50%** vs. typical projects | [Siemens success story](https://www.siemens.com/lv-lv/company/insights/success-stories/hugo-beck-digital-twin/) |
| **Tronrud Engineering** (Norway) | Packaging machinery | Digital twin | Design phase −10%, **commissioning −20–25%** (as reported) | [Packaging World](https://www.packworld.com/trends/digital-transformation/article/21104216/how-packaging-and-processing-machine-builders-are-using-digital-twin-technology) |
| **IDC** (intralogistics consultancy) | Intralogistics | Siemens Plant Simulation | **Launch 3 weeks sooner** | [Siemens case study](https://resources.sw.siemens.com/de-DE/case-study-idc) |
| Generic vendor claims | n/a | n/a | Siemens: "shortens real commissioning time by **up to 70%**". Comau: a customer cut commissioning **40%** | [Siemens](https://www.siemens.com/en-us/products/industrial-lifecycle-training-services/virtual-commissioning/); [Comau](https://www.comau.com/en/our-offer/services/3d-simulation-virtual-commissioning/) |

**Planning range to quote:** vendor cases cluster around **20–50% less commissioning time, with best cases at ~70%**. On-site weeks shrink to days.

**[UNVERIFIED]** A widely repeated "field study" claim says a small PLC system (17 sensors, 10 actuators) with VC went from **37% to 84% of requirements met**, with **−75% real commissioning time** and **−15% time-to-market** ([automationprogram.com](https://www.automationprogram.com/virtual-commissioning-automation.php); also echoed by Visual Components). We could not trace the original. Don't put it on a slide.

### 4.3 Independent and academic evidence, with the caveats judges might raise

- **Lechler, Fischer, Metzner, Mayr, Franke (FAU), *Procedia CIRP* 81 (2019), scientific review:** VC improves quality and efficiency and decreases time, but **is not yet widely adopted** ([record](https://cris.fau.de/publications/221470031/); DOI 10.1016/j.procir.2019.03.278). [IND]
- **Albo, Chalmers licentiate thesis (2022):** VC has helped reduce on-site commissioning time, but **financial benefits have been hard to prove vs. traditional methods**, partly because of missing standards ([Chalmers](https://research.chalmers.se/en/publication/530153)). [IND]
- **Zäh, Wünsch et al., "Nutzen der virtuellen Inbetriebnahme: Ein Experiment" (ZWF 2006):** because commissioning is unpredictable, "the amount of saved time cannot be measured" precisely ([TUM](https://portal.fis.tum.de/en/publications/nutzen-der-virtuellen-inbetriebnahme-ein-experiment/)). [IND] Use this to sound measured: we claim earlier bug discovery, not a guaranteed X% saving.
- **Reinhart & Wünsch, *Production Engineering* 1(4) (2007):** "control software engineering often still tends to be the last step within the development process. To a large extent it is carried out during the commissioning phase". DOI 10.1007/s11740-007-0066-0. [IND]
- **Shahim & Møller (Aalborg), Winter Simulation Conference 2016:** an economic-justification framework. VC "promises a great reduction in the system ramp-up time" ([PDF](https://www.informs-sim.org/wsc16papers/212.pdf)). [IND]
- **Building the simulation model is the cost barrier.** A Korean VC review notes that building virtual plant models takes substantial time ([newnonmun](https://www.newnonmun.com/article=10736795)). Siemens researchers (Diekmann et al., arXiv 2606.03255, AUTOMATION 2026) call VC-model building "labor-intensive" and propose LLM multi-agents to semi-automate it ([arXiv](https://arxiv.org/abs/2606.03255)). [IND]
  - This supports MongoMation's choice to use **off-the-shelf Factory I/O scenes plus auto-generated test scenarios** rather than bespoke twins.

### 4.4 Adoption: the gap MongoMation addresses

- **Kunz et al. (FAU, ASIM 2023) industry survey:** **"just over half of the respondents use VC, albeit rarely to occasionally."** **Barriers "are not technological."** Test automation is found only in large companies ([record](https://cris.fau.de/publications/310833827)). [IND]
- **Fraunhofer IWU "SaxoVI" study (press release 13 Aug 2024):** **>90%** of surveyed small and medium machine and plant builders in Saxony know VC, and almost as many rate its potential as high, but **"only a few"** actually use it in practice ([Silicon Saxony](https://silicon-saxony.de/en/fraunhofer-iwu-saxon-machine-manufacturers-often-do-not-yet-take-advantage-of-virtual-commissioning/); [IWU PDF](https://www.iwu.fraunhofer.de/content/dam/iwu/de/documents/Presse/2024-Saechsische-Maschinenbauer-nutzen-Vorteile-der-Virtuellen-Inbetriebnahme-oft-noch-nicht.pdf)). [IND]
- **Simulation skills demand up 75% in five years** (Deloitte/MI 2024, above), so the skill is scarce as well as the tooling.

### 4.5 Market size (low credibility, don't lead with it)

- QYR-type reports: **US$728M (2023) to US$1.70B (2029), ~15.2% CAGR** ([GII listing](https://www.gii.tw/report/qyr1400623-global-virtual-commissioning-market-research.html)). [MKT]
- Another estimate: **US$1.25B (2024) to US$4.86B (2034), ~14.5% CAGR** ([TimesTech](https://timestech.in/virtual-commissioning-market-to-surpass-usd-4-86-billion-by-2034/)). [MKT]
- **Safe phrasing:** "analysts estimate a ~$1B market growing ~15% a year".

---

## 5. Process-specific pain points (candidate demo processes)

Factory I/O scene mapping comes from the team's `factoryio.md`, which lists 21 built-in scenes.

### (a) CNC machine tending / machining cells

- **Factory I/O scene:** **Production Line**, which "produce[s] the same number of lids and bases by controlling two machining centers". The machining-center start/stop/reset are PLC outputs.
- **Typical failure modes:**
  - Part not present or not seated (sensor)
  - Robot/CNC handshake time-outs
  - Machine alarm or error signal mid-cycle
  - Door or interlock faults
  - Crashes
  - Chip and coolant contamination
  - Upstream starvation or downstream blocking
- **Evidence:**
  - Average CNC **machine utilization was 25.9% in 2022** (23.9% in Q4 2022), from controller data on thousands of US machine tools ([MachineMetrics "2022 by the numbers"](https://www.machinemetrics.com/stateoftheindustry2019); the URL says 2019 but the content is 2022). [VEND data]
  - The two most common spindle failure modes are **crashes and contamination (chips and coolant)** (Motor City Spindle Repair via [MSC BetterMRO](https://www.mscdirect.com/betterMRO/msc-generate-pdf/11371)). [VEND/industry]
  - Lights-out machining hinges on chip evacuation and tool-wear monitoring to avoid scrapped parts ([Modern Machine Shop, May 2023](https://modernmachineshop.mydigitalpublication.com/may-2023/page-62)). [ASSOC/media]
  - Safety: robotic cells draw people in when sensors fault. See the Ajin USA fatality in §7.
- **Demo fault injections:**
  - A machining center raises an error mid-cycle. Expected: hold the part, stop feeding that machine, rebalance to the other machine, alarm.
  - A part-present sensor sticks ON. Expected: detect it via a time-out or plausibility check, not a crash.
  - A downstream block. Expected: no overfeed.
- **Metric to show:** lids:bases balance maintained, zero collisions or double-loads, time-to-detect.

### (b) Assembly cells (lids on bases, pick-and-place)

- **Factory I/O scenes:** **Assembler** ("assemble parts made of lids and bases using a two-axis pick and place"), **Pick & Place (Basic)** and **Pick & Place XYZ**.
- **Typical failure modes:**
  - Part-feeding jams
  - Missing or misoriented part
  - Gripper fails to grip or drops the part
  - Pick-position sensor misses
  - Mismatched counts (lid without base)
  - Axis does not reach limit (time-out)
- **Evidence:**
  - **Part-feeding jams are the most common cause of downtime in automated assembly.** At only 5 bad parts per 10,000, a 250-part/min system stops every ~8 min, and 2-min restarts mean **20% downtime** ([Assembly Magazine](https://assemblymag.com/articles/85241-station-to-station-buffers-maximize-uptime-in-automated-assembly)). [industry commentary]
  - DFMA planning default: **~2 defective parts per 1,000 cause a stoppage, ~30 s each** ([DFMA](https://www.dfma.com/support/Downloads/AutomaticAssembly.pdf)).
- **Demo fault injections:**
  - A jammed base on the infeed. Expected: stop the feeder, alarm, don't place a lid in air.
  - Lid gripper loses its part. Expected: detect via a "part at destination" time-out, retry once, then fault.
  - A stuck "lid at pick position" sensor.
- **Metric to show:** 0 lids placed without bases; jam detected in under N seconds; recovery without manual reset where safe.

### (c) End-of-line packaging & palletizing (the most common PLC job)

- **Factory I/O scenes:** **Palletizer** ("palletize cases in several layers"), **Sorting by Weight** (checkweigher-like reject), **Sorting by Height**, **Buffer Station** and **Converge Station**.
- **Typical failure modes:**
  - Case jams at infeed, turners or pushers
  - Photo-eye blocked or dirty (stuck ON or OFF)
  - Wrong layer pattern after a changeover
  - Pallet not present
  - Stack collapse
  - Mis-sorted rejects
  - Accumulation or back-pressure overflow
  - Label and coder stops upstream
- **Evidence:**
  - **OEE:** "85% is considered world class for discrete manufacturers, **60% is fairly typical**", and 40% is a common starting point (Vorne, [LeanProduction.com](https://leanproduction.com/oee)). [VEND/industry benchmark; packaging-specific averages are mostly vendor blogs]
  - **Downtime-prone:** CPG managers rate packaging machines as **more downtime-prone than other machine types** (PMMI BI 2021, [Packaging World](https://www.packworld.com/issues/business-intelligence/article/21307820/predictive-maintenance-pain-points-in-packaging-machinery)). [ASSOC]
  - **Cost:** FMCG downtime **~$36k/hour** (low end, Siemens). F&B **$4k–$30k/hour** (ABB estimate). [VEND]
  - **Labour:** **95% of CPG companies struggle to hire skilled technicians** (PMMI 2025). [ASSOC]
  - **Changeovers:** SKU proliferation means more changeovers, and each changeover is a logic-path change (PMMI 2019; McKinsey). [ASSOC]
  - **VC proof point:** a bottling line's on-site controls commissioning went from 3 weeks to 4 days (Rockwell). Bastian's emulation found a box-size jam point before installation. [VEND-CASE]
- **Demo fault injections:**
  - A case jam on the infeed conveyor. Expected: stop upstream, don't count a ghost case, resume cleanly.
  - A stuck "case at pusher" photo-eye.
  - Pallet missing at layer drop.
  - A changeover to a new layer pattern from a plain-English spec edit. Show auto re-test, i.e. re-commissioning in minutes.
- **Metric to show:** cases palletized per minute vs. target, pattern correctness, jam detection time, zero double-drops.

### (d) Automated storage & retrieval / intralogistics

- **Factory I/O scene:** **Automated Warehouse**.
- **Typical failure modes:**
  - Load misrouted or stored in the wrong bin
  - Bin already occupied (sensor disagreement with the inventory model)
  - Crane or shuttle position not reached (time-out)
  - Jams at transfer points
  - Fork not home before travel
  - Ghost or missing loads after a power cycle
- **Evidence:**
  - **Denver airport baggage (GAO 1994):** "serious mechanical and software faults". Tests showed bags "misloaded, misrouted, or falling out of telecarts, causing the system to jam". The airport opened ~**16 months late**, with an estimated **~$360M** delay cost ([GAO](https://www.gao.gov/products/rced-95-35br); [Justia mirror](https://gao.justia.com/department-of-transportation/1994/10/new-denver-airport-rced-95-35br/)). [IND]
  - **Ferrero:** VC found ~95% of errors before go-live and reached 98% availability in 3 weeks vs. 6 months (Siemens). [VEND-CASE]
  - **Bastian:** ~5 weeks less on-site commissioning (Rockwell). [VEND-CASE]
  - **Downtime cost:** "more than $10k per hour" in an average DC ([Honeywell](https://automation.honeywell.com/ca/en/products/automation/solutions-by-system/connected-distribution-center/increase-reliability)). [VEND]
  - **Adoption:** **41%** of supply-chain organisations have adopted robotics and automation, and **42%** more plan to within 5 years (MHI 2025 Annual Industry Report via [Supply Chain 24/7](https://www.supplychain247.com/article/promat_2025_mhi_annual_industry_report_details_revealed)). [ASSOC, secondary]
  - **Ocado Erith (Jul 2021):** a fire "appears to have been caused by the collision of three bots on the grid" ([The Register](https://www.theregister.com/2021/07/19/ocado_robot_crash/)). See §7. [media]
- **Demo fault injections:**
  - Target bin already occupied. Expected: logic checks the sensor before placing.
  - Crane position sensor fails. Expected: a time-out, a safe stop and no blind travel.
  - Infeed jam.
- **Metric to show:** zero wrong-bin stores, inventory model equals physical state, recovery after a fault.

### (e) Liquid filling & batching (F&B, pharma)

- **Factory I/O scenes:** **Filling Tank (Timers)** and **Level Control** (PID).
- **Typical failure modes:**
  - **Overfill / tank overflow** (level sensor stuck)
  - **Underfill** (flow or valve fault)
  - **Dry-running pumps** (empty-tank sensor fails)
  - Valve commanded but not moving (no feedback check)
  - Timer-based filling drifting with pressure
  - Batch-record gaps (who, what, when, deviations)
- **Evidence:**
  - **Buncefield 2005 (UK):** the tank level gauge stuck and the independent high-level switch was inoperable. The tank overfilled with petrol and exploded, with an **estimated cost above £1bn** ([COMAH CA report, 2011](https://www.icheme.org/media/10706/buncefield-report.pdf)). [IND] See §7.
  - **BP Texas City 2005:** the level transmitter showed ~10 ft and falling while the tower overfilled. The high-level alarms didn't sound. **15 killed, ~170 injured** ([CSB](https://www.csb.gov/csb-issues-preliminary-findings-in-bp-texas-city-refinery-accident-investigators-present-data-in-public-meeting/)). [IND]
  - **Pharma batch records:** FDA Form 483 analyses show **21 CFR 211.192 (production record review)** as the #2 most-cited section for sterile drug makers in 2024, with the **largest increase (+171%)**. 211.100 (written procedures and deviations) is also near the top ([Pharmaceutical Online](https://www.pharmaceuticalonline.com/doc/2024-trends-in-fda-observations-for-sterile-drug-manufacturers-0001)). [ASSOC analysis of FDA data]
  - **Biomanufacturing:** batch failures occur at facilities roughly **every ~51 weeks** (BioPlan survey of 222 executives, 2016, via [GEN](https://www.genengnews.com/insights/batch-failure-rates-in-biomanufacturing)). [ASSOC]
  - **Food recalls:** average **direct** cost **~$10M** (FMI/GMA study, via [Food Dive](https://www.fooddive.com/news/more-than-money-what-a-recall-truly-costs/426855/)). [ASSOC, secondary]
  - **Overfill "giveaway":** producers deliberately overfill to avoid under-weight penalties, and tighter fill control recovers margin. Vendor numbers vary widely, so we rate them [UNVERIFIED].
- **Demo fault injections:**
  - The high-level sensor sticks OFF while filling. Expected: a plausibility check (flow × time vs. level) stops fill, raises an alarm and closes the inlet. This is the Buncefield pattern.
  - The level transmitter freezes. Expected: a "no change while valve open" detector.
  - The discharge valve fails to open. Expected: pump interlock, no dry-run.
- **Metric to show:** zero overflow events under every injected sensor fault; MongoDB holds an auto-generated batch/event record per run. That is a natural MongoDB story: time-series runs plus an audit trail.

---

## 6. AI for PLC code generation: landscape and honest positioning

### 6.1 Incumbent products

| Offering | Who / when | What it does | How output is validated | Published results | Gap vs. MongoMation |
|---|---|---|---|---|---|
| **Siemens Industrial Copilot** (TIA Portal) | Siemens + Microsoft. Shown SPS **Nov 2023** with Schaeffler. Downloadable **mid-2024** per trade press | Natural language → **SCL** code inserted into TIA Portal. Explains code, drafts HMI, searches manuals | Engineer review + TIA compile | Qualitative only ("significantly reduce time, effort and the probability of errors") ([Automation.com, Nov 2023](https://www.automation.com/en-us/articles/november-2023/ai-industry-schaeffler-siemens-industrial-copilot)) | No published simulation-in-loop or fault testing |
| **Siemens Engineering Copilot TIA** | **Beta at SPS, Nov 2025**. Managed service, pilot customers | "Autonomously executes" engineering tasks. Lists **"code generation and testing"** | Not public | None ([Automation World](https://automationworld.com/factory/digital-transformation/news/55332816/siemens-ag-siemens-unveils-generative-ai-copilot-for-autonomous-engineering-at-sps-2025)) | TIA-only, closed |
| **Siemens Eigen Engineering Agent** | **Launched 20 Apr 2026** (Hannover Messe), after tests with **>100 customers in 19 countries** | Generates SCL/LAD, fixes compile errors, **generates test logic**, enforces style guides, documents (capability list per a secondary summary, [antomatix](https://antomatix.com/?p=7044)). heise: "Before the results are shown to the engineer, the Eigen Engineering Agent checks all outcomes." | Internal checks; no public detail on simulation runs | Vendor claims **2–5× faster**, **up to 80% higher quality**, **up to 50% more efficiency** ([heise](https://heise.de/-11264894); [ARC](https://www.arcweb.com/industry-best-practices/copilot-engineering-agent-siemens-targets-automation-productivity-gap); [computer-automation.de](https://www.computer-automation.de/engineering/hannover-messe-2026--siemens-stellt-neuen-ki-agenten-vor.htm)) | Strongest incumbent. TIA-only. No public evidence of fault injection or cross-project learning |
| **Rockwell FactoryTalk Design Studio Copilot** | Rockwell + Microsoft (Azure OpenAI), **Nov 2024**. **Nov 2025:** edge SLM (NVIDIA Nemotron-Nano-9B-v2 fine-tuned on Copilot data, air-gapped) | NL → ladder/code, explain code, troubleshoot. Newer "plan and build agents" work from specs and I/O lists | Engineer-in-loop | Qualitative ([Packaging World](https://www.packworld.com/trends/digital-transformation/article/22927841/rockwell-automations-factorytalk-design-studio-adds-generative-ai-copilot); [Nasdaq PR, Nov 2025](https://www.nasdaq.com/press-release/rockwell-automation-advance-industrial-intelligence-through-edge-based-generative-ai)) | Logix-only |
| **Rockwell "AI-orchestrated factory engineering"** | **Hannover Messe, 20–24 Apr 2026**, with Microsoft Foundry. The release says commercial availability was expected in May 2026; we did not confirm it | **Closed loop: Design Studio generates logic → Emulate3D digital twin emulates it → performance results feed back.** Stated goal: go from a validated model to a fully tested controller project before hardware is deployed | Emulate3D digital twin | Demo; no published metrics ([Rockwell PR](https://www.rockwellautomation.com/en-gb/company/news/press-releases/ai-orchestrated-factory-engineering-at-hannover.html); [PR Newswire](https://tools.prnewswire.com/en-us/live/20823/release/20260420EN16462)) | **Closest analogue to MongoMation.** Vendor-locked and commercial-license heavy. No public evidence of automatic fault injection, auto-repair or self-improvement |
| **Schneider Electric Industrial Copilot** | Prototype at Automate, May 2025. Launched **Jun 2025** (Microsoft Azure AI Foundry), in EcoStruxure Automation Expert | A PLC Code Generation Copilot that generates, explains and tests PLC code using Schneider libraries and guardrails. Human review | Library-based plus human | Vendor claim **30–50% less development time** ([Schneider blog, Nov 2025](https://blog.se.com/digital-transformation/artificial-intelligence/2025/11/14/engineering-at-scale-how-ai-is-transforming-plc-coding/); [ARC](https://www.arcweb.com/node/159941)) | Schneider ecosystem |
| **CODESYS Development System MCP Server** | 2026 product. Won Computer & Automation Product of the Year 2026 (Software/IT) | Lets any MCP-capable LLM generate, analyze and optimize **IEC 61131-3 ST**, with **automatic error correction from compiler output**. Tested with Claude Desktop and GPT-5; vendor says **Claude models gave the best ST quality** | Compiler loop | No public accuracy numbers ([CODESYS](https://www.codesys.com/products/engineering/ai-supported-engineering/); [docs](https://content.helpme-codesys.com/en/CODESYS%20Development%20System%20MCP%20Server/_idemcp_start_page.html)) | ST only. Compile-level validation, not behaviour |
| **Beckhoff TwinCAT Chat** | Shown Hannover Messe, **Apr 2023** | LLM in TwinCAT XAE: create, complete and optimize function-block code; documentation | Engineer | None; current product status unclear ([Drives & Controls](https://m.drivesncontrols.com/news/fullstory.php/aid/7339/.html); [Beckhoff](https://www.beckhoff.com/nl-be/company/news/fast-and-efficient-plc-code-generation-and-more-with-artificial-intelligence.html)) | n/a |
| **Copia Copilot** | Copia (Git for PLCs), **Nov 2024**, alpha → beta | Studio 5000 code generation, LD↔ST translation, explanation | Engineer | None ([Copia](https://announce.copia.io/introducing-copia-copilot-ai-powered-industrial-code-management-4hPlIc)) | Rockwell-only |
| **ABB Spec2Control** (research → product) | ABB Research, arXiv **Oct 2025**. Being integrated into ABB tools; open-source variant | Control narratives (requirements) → DCS control strategies | Test cases | **98.6%** of control-strategy connections generated correctly; **94–96% human labour saved**, on 10 narratives / 65 test cases ([arXiv 2510.04519](https://arxiv.org/abs/2510.04519)) | Process/DCS focus, not discrete-machine behaviour |
| **Startups** | **PLCs.ai** (seed early 2026) and **PLC Copilot** (Seattle, seed Jan 2026) | Analyze, troubleshoot and generate PLC code | Unknown | None public ([Caplight: PLCs.ai](https://www.caplight.com/company/plcs); [Caplight: PLC Copilot](https://www.caplight.com/company/plccopilot)) | Early |

### 6.2 Academic state of the art

| Work | Who / venue | Approach | Validation | Key result |
|---|---|---|---|---|
| **ChatGPT for PLC/DCS control logic** | Koziolek et al. (ABB), ETFA 2023 | 100 prompts in 10 categories, GPT-4 | Manual | ST "syntactically correct in many cases". The prompt set is meant as the basis for a benchmark ([arXiv 2305.15809](https://arxiv.org/abs/2305.15809)) |
| **LLM4PLC** | Fakih et al. (UC Irvine + Siemens), **ICSE-SEIP 2024** | User-guided loop: grammar checker, compiler, **SMV/nuXmv model checking**, LoRA fine-tuning | Formal plus FischerTechnik testbed | States **"GPT-4 and LLaMa2 fail to produce valid programs for ICS operated by PLCs"**. The pipeline lifted **generation success from 47% to 72%**. Expert quality rose 2.25 → 7.75/10 per arXiv (3.0 → 7.2 per the ICSE page) ([arXiv](https://arxiv.org/abs/2401.05443); [ICSE](https://conf.researchr.org/details/icse-2024/icse-2024-software-engineering-in-practice/32/LLM4PLC-Harnessing-Large-Language-Models-for-Verifiable-Programming-of-PLCs-in-Indus)) |
| **Agents4PLC** | Liu, Zeng et al. (Zhejiang Univ.), arXiv **Oct 2024** | Multi-agent: generate, syntax check, **formal verification (nuXmv/PLCverif)**, debug. Benchmark with formal specs | Formal | "Up to 68.8%" formal verification success on 23 tasks, as cited by a later paper [UNVERIFIED]. Implementation not released, per the AutoPLC authors ([arXiv 2410.14209](https://arxiv.org/abs/2410.14209)) |
| **LLM test-case generation for control logic** | Koziolek et al. (ABB), 2024 | LLM writes unit tests for 10 OSCAT function blocks | Execution | High statement coverage for low and medium complexity, but **many tests had wrong assertions** ([arXiv 2405.01874](https://arxiv.org/abs/2405.01874)) |
| **Online-feedback training** | Haag et al. (Siemens), LLM4Code@ICSE 2025 | DPO training with compiler (Rusty) plus LLM-judge feedback | Compile | Higher compile success and semantic precision ([arXiv 2410.22159](https://arxiv.org/abs/2410.22159)) |
| **AutoPLC** | Yang et al. (with a Siemens co-author), ASE 2025 industry showcase | Vendor-aware RAG (TIA SCL, CODESYS) plus IDE validation | Compile | **90%+ compilation success on 914 tasks, ~$0.13/task**. Open source ([arXiv 2412.02410](https://arxiv.org/abs/2412.02410)) |
| **LLM comparative study** | TU Dresden, 2025 | Gemini 2.5 Pro, DeepSeek V3, Grok 3 → PLCopen XML into CODESYS | Import, compile, functional | ST works for a wide range of tasks. Few-shot and CoT help; FBD is harder ([TU Dresden](https://fis.tu-dresden.de/portal/en/publications/generation-of-plc-code-using-large-language-models-a-comparative-study(73161f03-7513-46b1-a4b1-94ca2d14d188).html)) |
| **LLM agents + digital twin for fault handling** | Gill et al., arXiv **May 2025** | Monitoring → Action → **Validation in simulation (OpenModelica)** → Reprompting agents | Simulation | Mitigated a pipe-clogging fault in a mixing module "with only a few reprompts". These are runtime corrective actions, not program synthesis ([arXiv 2505.02076](https://arxiv.org/abs/2505.02076)) |
| **KG multi-agent VC-model building** | Diekmann et al. (Siemens), arXiv 2026 / AUTOMATION 2026 | Builds VC models semi-automatically from TIA Portal + NX MCD | n/a | Addresses VC model cost ([arXiv 2606.03255](https://arxiv.org/abs/2606.03255)) |
| **SemaPLC** | Midea AI, arXiv **Aug 2026**, open source | "Verification-gated" harness: specification, compilation **and live-runtime execution** checks | **Runtime/dynamic** | **72.6% mean strict verified pass** across 7 models on 117 tasks (Agents4PLC baseline 63.9%). **Static scores of all methods fall within 10 points, but dynamic-behaviour scores separate them sharply: 22.4–31.4 for baselines vs. 52.2.** Engineers had to repair **43 of the 117** benchmark tasks ([arXiv 2608.18565](https://arxiv.org/abs/2608.18565)) |
| **Review** | *Hungarian Journal of Industry & Chemistry*, 2026 | n/a | n/a | Generative PLC programming is "still in its early stages… exploratory research and cautious implementation" ([HJIC](https://hjic.mk.uni-pannon.hu/index.php/hjic/article/view/1295)) |

### 6.3 What is missing, and where MongoMation honestly fits

1. **Validation is mostly compile, static or formal.** Most systems check that code *compiles* or satisfies *hand-written formal specs* (LLM4PLC, Agents4PLC, AutoPLC, CODESYS MCP). SemaPLC's data shows **behavioural (dynamic) tests are what separate good from bad generators**. A physics sim with moving parts tests timing, part flow and interactions that formal specs rarely encode.
2. **Fault injection is absent from the AI generation loop.** We found **no public product evidence** of AI code generators that automatically inject jams, stuck or failed sensors and machine error signals. Fault-injection *testing* of PLC code exists in academia (TUM 2014/2017), so combining it with LLM generation and automatic repair is the contribution, not fault injection itself.
3. **Automatic diagnose → repair → re-test loop.** Agents4PLC and SemaPLC repair against verifier and compiler feedback. Gill et al. repair runtime *actions* against a simulation. **Repairing PLC *programs* against simulated plant behaviour under injected faults** is the gap.
4. **Self-improvement across runs and projects.**
   - Rockwell fine-tunes an edge model on Copilot data, which is offline learning from usage. Haag et al. train with compiler feedback.
   - We found **no product that publicly claims a per-project engineering memory**: failures, root causes and patches that measurably reduce repair iterations next time.
   - This is MongoMation's MongoDB-native story: store every run, trace, fault, diagnosis and patch, retrieve them for new specs, and **show the learning curve** (iterations-to-green falling over runs).
5. **Open and vendor-neutral.** Incumbents are tied to their ecosystems: Siemens TIA, Rockwell Logix/Emulate3D, Schneider EAE. MongoMation targets portable IEC 61131-3 ST on OpenPLC and Factory I/O. **Honest caveat:** vendor dialects matter, and AutoPLC exists because of this. Porting to Siemens SCL or Rockwell is future work.

**Claims to avoid**

- "First to validate AI-generated PLC code in simulation." Rockwell's Apr 2026 Emulate3D loop, SemaPLC's live runtime and LLM4PLC's testbed all precede it.
- "Safety-certified" or "production-ready". Safety functions (IEC 61508/62061, ISO 13849) still need qualified human engineering and validation.
- "Replaces controls engineers." Frame it as giving each scarce engineer a tireless test-and-repair loop.
- Quoting vendor numbers (2–5×, 30–50%, −70%) as facts. Attribute them.

---

## 7. Incident stories (with sources)

### Top 3 for the pitch

**1. Buncefield, UK, 11 Dec 2005: a stuck level sensor overflows a tank.** [IND]

- **What happened:** petrol was being pumped into Tank 912 overnight. Its automatic tank gauge **had stuck**; summaries of the investigation report **14 sticking episodes** between 31 Aug and 11 Dec 2005, often reset without being logged as defects.
- **Backup failed too:** the **independent high-level switch**, the last line of defence, was **inoperable**. It needed a padlock to hold its test lever in the operating position, and the supplier never communicated that to the installer, maintainer or operator.
- **Result:** no alarm and no automatic shutdown. The tank overfilled, the vapour cloud ignited and the explosion injured **40+ people**, with no fatalities.
- **Cost:** commonly estimated at **over £1 billion**, cited as Britain's costliest industrial disaster.
- **Sources:**
  - COMAH Competent Authority, *Buncefield: Why did it happen?* (Feb 2011) ([PDF via IChemE](https://www.icheme.org/media/10706/buncefield-report.pdf))
  - [IFSEC Global](https://www.ifsecglobal.com/poor-maintenance-and-safety-management-caused-buncefield-fire-report-finds/)
  - [OHS Online, 2011](https://ohsonline.com/articles/2011/02/19/buncefield-report-faults-psm-failures.aspx)
  - [Environment Agency blog, Dec 2025](https://environmentagency.blog.gov.uk/2025/12/10/buncefield-20-years-since-the-incident-that-changed-how-we-regulate/)
- **MongoMation tie-in:** in the Filling Tank or Level Control scene, inject "level sensor stuck". Generated logic must catch the implausibility (inlet open, level unchanged; flow × time vs. level) and stop the fill.

**2. Material-handling control systems that weren't tested enough: Denver airport (1994–95) and Heathrow Terminal 5 (2008).** [IND] plus media

- **Denver:**
  - The automated baggage system still had **"serious mechanical and software faults"**. Tests showed **bags misloaded, misrouted, or falling out of telecarts, causing the system to jam**.
  - The airport opened **~16 months late** (Oct 1993 → Feb 1995). GAO estimated the delay at **~$360M**, plus **~$51M** for a conventional backup system.
  - Sources: [GAO RCED-95-35BR, 14 Oct 1994](https://www.gao.gov/products/rced-95-35br); [Justia mirror](https://gao.justia.com/department-of-transportation/1994/10/new-denver-airport-rced-95-35br/). Flightglobal put the cost at ~$33M per month of delay ([Flightglobal](https://www.flightglobal.com/open-for-business/16578.article)).
- **Heathrow T5:**
  - In the first ~10 days, **~28,000 bags** failed to travel with their owners and **500+ flights** were cancelled ([Airport Technology](https://www.airport-technology.com/?p=19958)). BA put its cost at **~£16M** ([TravelMole](https://travelmole.com/news/t5-fiasco-costs-ba-at-least-a16m)).
  - The Commons Transport Committee called it a **"national embarrassment"**. Pre-opening trials "failed in the ultimate objective of getting the system to a point where it worked well enough", and it cited **insufficient system testing and staff training**, with the building handed over late ([HC 543, 3 Nov 2008, committee index](https://publications.parliament.uk/pa/cm200708/cmselect/cmtran/cmtran.htm); [Building](https://building.co.uk/news/mps-label-t5-a-national-embarrassment/3126590.article)).
  - Counts vary by source and cut-off date; 23,205 bags needed manual sorting, per press coverage of the report.
- **MongoMation tie-in:** commissioning sits on the critical path. Test routing logic and jam and misroute handling in simulation, automatically, *before* go-live.

**3. Ajin USA, Cusseta, Alabama, 18 Jun 2016: a sensor fault draws a worker into a robot cell.** [IND, regulator, plus media]

- **What happened:** the line stopped. **Regina Elsea, 20**, and co-workers entered a robotic station **to clear a sensor fault**. The robot **restarted abruptly** and crushed her, and she died the next day.
- **Regulator response:** OSHA cited the Hyundai/Kia supplier's parent for **23 violations**, including **19 egregious willful violations**. Findings included failing to lock out energy before workers entered the cell. Proposed penalties were **~$2.5M**. Later reports cite **~$1.3M upheld**, plus a DOJ **$50k fine and $1M restitution**.
- **Sources:** [EHS Today](https://www.ehstoday.com/standards/osha/article/21918171/bride-to-be-crushed-auto-parts-supplier-for-kia-and-hyundai-and-staffing-agencies-fined-25-million); [WTVM](https://www.wtvm.com/story/34059429/al-auto-parts-manufacturer-fined-25m-after-womans-workplace-death/); [Manufacturing Dive](https://www.manufacturingdive.com/news/ajin-usa-joon-OSHA-hyundai-supplier-safety-penalty/644590/)
- **MongoMation tie-in:** handle this carefully, since MongoMation is not a safety system. Ambiguous faults pull humans into hazardous cells under pressure to "get it running". Logic that diagnoses faults precisely, recovers safely where possible and enforces a proper reset sequence reduces those interventions.

### Backups

- **BP Texas City, 23 Mar 2005.** The raffinate splitter's only level transmitter falsely read ~10 ft and "drifting downward" while the tower filled far higher. **Two high-level alarms failed.** Repairs had been deferred until after startup. **15 killed, ~170 injured** ([CSB preliminary findings](https://www.csb.gov/csb-issues-preliminary-findings-in-bp-texas-city-refinery-accident-investigators-present-data-in-public-meeting/); [CSB urgent recommendations](https://www.csb.gov/assets/1/20/BP_Recs.pdf)). [IND]
- **Texaco Milford Haven, 24 Jul 1994.** A level control valve **failed closed while the control system showed it open**. Operators faced **275 alarms in the final 11 minutes**. **26 injured**, **~£48M** damage ([HSE case study](https://www.hse.gov.uk/comah/sragtech/casetexaco94.htm); [IChemE summary](https://www.icheme.org/media/14216/milford-haven-incident-summary-24-jul-94.pdf)). [IND]
- **Bayer CropScience, Institute WV, 28 Aug 2008.** The plant restarted after an upgrade to a **new distributed control system**:
  - the pre-startup safety review was **not applied to the control-system redesign**
  - checkout and calibration were incomplete
  - operators were not trained on the new DCS
  - an interlock was bypassed

  A runaway reaction ruptured a vessel. **2 killed, 8 injured** ([CSB testimony](https://www.csb.gov/in-house-testimony-csb-chairman-john-bresland-cites-significant-lapses-in-process-safety-in-august-2008-bayer-cropscience-explosion/); [EHS Today](https://ehstoday.com/emergency-management/article/21905512/csb-multiple-deficiencies-led-to-2008-bayer-cropscience-explosion)). [IND]
- **Tesla Model 3, Apr 2018.** Musk: "We had this crazy complex network of conveyor belts and it was not working, so we got rid of that whole thing". "Excessive automation at Tesla was a mistake." The plant missed its 2,500/week target, producing 2,020 ([Fortune, 13 Apr 2018](https://fortune.com/2018/04/13/tesla-elon-musk-robot-human-model-3)). [media]
- **Ocado Erith, 16 Jul 2021.** A fire "appears to have been caused by the collision of three bots on the grid". About 800 staff were evacuated, and <1% of the grid was damaged ([The Register](https://www.theregister.com/2021/07/19/ocado_robot_crash/)). The **Andover fire (Feb 2019)** came from a battery-charger fault, and the site was rebuilt ([Logistics Manager](https://www.logisticsmanager.com/ocado-fire-caused-by-battery-charger-fault)). Loss estimates in trade press, such as ~£35M of lost sales for Erith and ~£100M for Andover, are [UNVERIFIED].

---

## 8. Suggested pitch lines (each traceable)

1. "Unplanned downtime costs the world's 500 biggest companies **$1.4 trillion a year, 11% of revenue**. An idle car line burns **$2.3 million an hour**." (Siemens, True Cost of Downtime 2024)
2. "The UK safety regulator found **44% of control-system failures start with a bad specification** and **20% come from changes after commissioning**." (HSE, *Out of Control*)
3. "Commissioning eats **15–20% of an automation project**, and about **two-thirds of that is fixing control-software bugs on site**." (Visual Components; Univ. Augsburg thesis) Attribute it, because the primary study isn't traced.
4. "Virtual commissioning works. Ferrero caught **~95% of errors before go-live**, and Bastian cut **five weeks** of on-site commissioning and found a jam before it happened. Yet most companies use it rarely, and **only large companies automate testing**." (Siemens and Rockwell case studies; FAU survey 2023)
5. "LLMs alone aren't enough: **'GPT-4 and LLaMa2 fail to produce valid programs'** for PLCs (ICSE 2024). Static checks barely separate AI code generators, but **behaviour tests do** (SemaPLC 2026)."
6. "Engineers are scarce: **1.9 million US manufacturing jobs could go unfilled by 2033**, and **95% of packaged-goods makers can't find enough skilled technicians**." (Deloitte/MI 2024; PMMI 2025)
7. "MongoMation turns a plain-English spec into PLC code, then **proves it on a 3D simulated factory, breaks it on purpose** (jams, stuck sensors, machine faults), **fixes it automatically, and remembers the fix** for next time."

---

## 9. Gaps we could not close (be ready if asked)

- **No authoritative cross-industry split of downtime causes** (sensor vs. jam vs. logic). Use the HSE breakdown for control-system failures, OREDA for field-device vs. controller failures, and the Copia vendor survey (30–52%) for code-related downtime, all attributed.
- **No independent, multi-project measurement of VC savings.** Evidence is vendor cases plus academic reviews that say benefits are real but hard to quantify (Zäh 2006; Albo 2022).
- **No authoritative count of the controls-engineer shortage specifically.** The data covers skilled manufacturing and technical roles broadly.
- **Packaging-line OEE averages are mostly vendor blogs.** Use the generic Vorne benchmarks (60% typical, 85% world class) and say so.
- **Agents4PLC's own headline numbers were not verified.** Use SemaPLC's head-to-head figure (63.9% vs. 72.6%) instead.
