# Factory I/O manufacturing use cases for the MongoMation demo

Researched 2026-10-11 for Factory I/O **2.5.x** (latest is 2.5.10). This builds on `factoryio.md` (same folder) and does not repeat its Web API, Modbus or forcing material. Read that file for API mechanics.

**Question answered here:** which Factory I/O scene gives the most compelling *"we are manufacturing something"* demo? The demo is an AI agent that writes IEC 61131-3 Structured Text, compiles it with OpenPLC, deploys it, tests it against the live 3D scene through Web API forcing, and repairs it from measured failures.

---

## 0. TL;DR

| Rank | Scene | Real-world operation | Why it wins | Main risk |
|---|---|---|---|---|
| **1** | **Production Line** (built in) plus a 4-button operator panel and a stack light added in ~25 min | **Robot-tended CNC machining cell.** Two machining centers, each loaded by an orange 6-axis robot behind a safety fence, turn raw blanks into **lids** and **bases**. | Best visuals and the most genuine "we make parts" story. The control logic is mostly digital and **LLM-friendly**: the robots and CNCs sequence themselves, and the PLC orchestrates feeding, start/stop, alarms, counting and balancing. Fault injection is natural (CNC alarm, jammed photo-eye, E-stop), and one cell can fail while the other keeps producing. | No operator panel ships with the scene. Each part takes ~35–38 s. Whether the station's start/stop/reset commands are edge- or level-triggered is unverified (5-minute check in §5). |
| **2** | **Assembler** (built in, zero scene edits) | **Final-assembly cell.** A gantry places a lid onto a clamped base to make the finished product. | The full panel already exists. All I/O is digital. A product comes out every ~10 s. "Missed pick" and "dead clamp sensor" are classic, highly visible faults. | Longer coupled sequence (about 13 steps across two sub-sequences). The Auto/Manual selector rests on Manual. |
| **3** | **Palletizer** (built in), as a stretch | **End-of-line case palletizing** with layer forming, clamping, plate drop and elevator | Large industrial machine, full panel, all digital, and a real end-of-line pain point | **High** sequence complexity (3 concurrent sequences). A layer takes ~33 s and a full pallet ~2 min. The LLM will likely need many repair iterations. **Safer alternative for #3:** Automated Warehouse (AS/RS). |

Avoid the sorting scenes (the "boxes" demo the lead dislikes) and these:

- **Pick & Place XYZ** and **Assembler (Analog)**: analog multi-axis positioning, for which we have no primitives.
- **Level Control**: PID, for which we have no primitives.
- **Filling Tank**: trivial, with no sensors and no panel.

Tags you need for #1 are in §4.1.6. The ten most important facts behind the #1 pick are:

1. The **Production Line has no tag-exposed operator panel.** Each Machining Center prefab carries its own switchboard and stack lights, but those buttons are not tags. You must add `Start`/`Stop`/`Reset`/`Emergency stop` (plus lights) yourself. [SCENE-FILE 2.5.10 + community]
2. **Default Modbus layout, confirmed from a 2.5.10 scene file and an independent export:**
   - DI 0–8: `Lids at entry`, `Lids center (busy)`, `Lids center (has error)`, `Lids at exit`, `Bases at entry`, `Bases center (busy)`, `Bases center (has error)`, `Bases at exit`, `FACTORY I/O (Running)`.
   - Coils 0–14: `Lids raw conveyor`, `Lids center (produce lids)`, `(start)`, `(reset)`, `(stop)`, `Lids exit conveyor 1`, `2`, `Bases raw conveyor`, `Bases center (produce lids)`, `(start)`, `(reset)`, `(stop)`, `Bases exit conveyor 1`, `2`, `Exit conveyor`.
   - HR 0–1: `Lids counter`, `Bases counter`.
3. **Pre-forced tags in the shipped scene:** `Lids emitter`, `Bases emitter`, `Remover`, and very likely `Lids center (produce lids)`. Never "release all forces". [SCENE-FILE ×2 copies; INFERRED for the pristine 2.5.10 file]
4. **Measured cycle times** (28-minute run, 1× speed) [OBSERVED]:

   | Cell | `busy` high | Idle | Per part | Parts in 28.4 min |
   |---|---|---|---|---|
   | Lids | 35.0 s | ~3 s | **~38 s** | 44 |
   | Bases | 32.0 s | ~3 s | **~35 s** | 48 |

   The CNC door stays closed for 5.0 s (lids) and 2.0 s (bases). The official machining times are 6 s and 3 s.
5. **The line drifts out of balance on its own.** The 44 vs 48 count above is why the scene's official objective, "produce the same number of lids and bases", is a real, testable business rule.
6. **Photo-eye polarity.** The entry and exit eyes are retroreflective: TRUE = beam clear, FALSE = part present. A blank arrives ~2.1 s after its raw conveyor starts and blocks the eye for ~0.6 s. A finished part blocks the exit eye for ~0.5 s, ~2.2 s before `busy` drops.
7. **Count on the `busy` falling edge, not raw exit-eye edges.** The Lids exit eye produced 3 spurious 80–90 ms blips in 44 cycles, which would overcount by ~7%. [OBSERVED]
8. **`has error`** = "invalid item detected at the entry bay". The station's red light comes on and **Reset** restores it. After the station's *own* E-stop, the station needs E-stop disarm plus Reset. [OFFICIAL]
9. **Forcing a station input only changes what the PLC sees.** Forcing `has error` will not turn the station's own stack light red, so add our own stack light for visible alarms. [INFERRED from forcing semantics]
10. **Saved cameras exist:** `Electric Board (lids)`, `Electric Board (bases)`, `Camera 2`–`Camera 7`. You can write `FACTORY I/O (Camera Position)` to zoom to the faulted cell. The index base is [UNVERIFIED].

---

## How this was researched, and evidence labels

docs.factoryio.com, community.factoryio.com, factoryio.com, YouTube and bin95/openplc forums are **blocked by the egress proxy** (403/ENOTFOUND). Official content therefore comes from **search-engine extracts** of those pages. The primary artifacts below were read directly from GitHub.

**Runtime captures of all 21 built-in scenes** (lordmoses/SCAPHY, IEEE S&P 2023, recorded Oct 2021–Jan 2022):

- Attribute headers give the complete tag list of each scene, including panels and pre-forced emitters.
- Data rows give timings.
- It includes a **28-minute Production Line run** (188,789 samples at ~9 ms).
- It also has scene screenshots and per-scene notes (`ICS-Scenarios.rtf`).

**Scene XML (`.factoryio`) files:**

- Production Line copies saved by **2.5.10** (2026-07), **2.5.5** and **2.4.3**.
- lmtriwork copies of most built-in scenes (2.2.2–2.5.4, some lightly modified).
- Student-built cells containing Machining Center, Stacker Crane, Safety Door, Two-Axis Pick & Place and others. These are the source of the part prefab names and default tag names.

**Official Real Games SDK sample controllers.** There is one per built-in scene (21 in total), and they give tag semantics and the reference sequence logic.

**Working third-party controllers:**

- nesfit/bonnet-ics-library Production Line Modbus controller and tag export.
- legsano/FactoryIO-OpenPLCEditor: **OpenPLC Structured Text** for a Machining Center cell and an Automated Warehouse.

| Label | Meaning |
|---|---|
| `[OFFICIAL]` | Real Games docs (via search extract), release notes, or the SDK |
| `[SCENE-FILE]` | Read directly from Factory I/O scene XML |
| `[OBSERVED]` | Runtime capture or working third-party code |
| `[INFERRED]` | Concluded from the above |
| `[UNVERIFIED]` | Plausible; test on your install |
| `[ESTIMATE]` | Engineering judgement, not measured |

---

## 1. Built-in scenes in 2.5.x: the complete list (21)

**Is the list complete?**

- The docs index states "Factory I/O comes with 21 Scenes". [OFFICIAL extract]
- The official SDK has exactly 21 scene controllers. [OFFICIAL]
- SCAPHY has 21 scene captures. [OBSERVED]
- No scene additions appear in the 2.5.x release-note extracts.

**How to read the I/O counts below:**

- They exclude system tags (`FACTORY I/O (…)`), unnamed `-` points, and the pre-forced Emitter/Remover tags.
- **DI** = process sensors + panel inputs. **DO** = actuators + lights.
- **AI/AO** = Float or Int analog values. "Int out" = displays, counters and setpoints.
- Panel "Full" = `Start`, `Stop` (NC), `Reset`, `Emergency stop` (NC), and an `Auto`/`Manual` selector, plus `Start light`, `Stop light` and `Reset light`.

Sources:

- Tag lists: [OBSERVED SCAPHY headers], cross-checked against [OFFICIAL SDK] and [SCENE-FILE].
- Equipment: [SCENE-FILE prefabs] where a file exists, otherwise inferred from tags and screenshots.
- Objectives: [OFFICIAL] docs/scene `<Description>`.

### 1.1 Summary table

| # | Scene (exact name) | Official objective | Real-world operation it represents | Key equipment | Operator panel | I/O |
|---|---|---|---|---|---|---|
| 1 | From A to B | Transport a box until it reaches a sensor | Conveyor positioning / index-to-stop (intralogistics basics) | 1 roller conveyor 4 m, 1 retroreflective sensor | **None** | DI 1, DO 1 |
| 2 | From A to B (Set and Reset) | Transport a box from sensor A to sensor B | Zone hand-off between two conveyors (latch logic) | Roller conveyors 2 m + 4 m, 2 retroreflective | **None** | DI 2, DO 2 |
| 3 | Filling Tank (Timers) | Fill and empty a tank using timers | Time-based dosing / batch fill-drain (process) | Tank (**digital mode, no level signal**), switchboard | Partial: `Fill` (NO) and `Discharge` (NC) buttons, 2 lights, `Timer` display. No Start/Stop/E-stop. | DI 2, DO 4, Int out 1 |
| 4 | Queue of Items (Counters) | Load and unload three boxes onto a conveyor | Accumulation / collating N items (e.g. before a case packer) | Roller conveyors, 3 diffuse sensors, low chute, emitter/remover | **None** | DI 3, DO 2 |
| 5 | **Assembler** | Assemble parts made of lids and bases using a two-axis pick and place | **Final assembly**: place a cover on a housing | Two-Axis Pick & Place (binary), 2 belt conveyors 4 m, 2 positioning bars (clamp + raise), 3 diffuse sensors, chutes, lid/base emitters, 2 removers | **Full** | DI 16 (10+6), DO 12 (9+3), Int out 1 |
| 6 | Assembler (Analog) | Same, using analog values | Same, but with servo-like analog positioning (motion control) | Two-Axis P&P (analog), 4 belt conveyors 2 m, 2 stop blades, aligners | **Full** | DI 10 (4+6), AI 2 float, DO 10 (7+3), AO 2 float, Int out 1 |
| 7 | **Automated Warehouse** | Transport, store and retrieve boxes from a rack | **AS/RS**: stacker crane storing loads in a 54-cell rack | Stacker crane + racks, entry/load/unload/exit conveyors, 4 position sensors, emitter/remover | **Full** | DI 15 (9+6), DO 10 (7+3), Int out 1 (`Target Position`) |
| 8 | Buffer Station | Buffer and separate up to five boxes | Accumulation + singulation/metering (stop-blade release, speed control) | 2 belt conveyors (**analog speed**), stop blade, 3 sensors, potentiometer | **Full** (+ `Buffer Vel.` potentiometer) | DI 9 (3+6), AI 1 float, DO 4 (1+3), AO 2 float, Int out 1 |
| 9 | Converge Station | Converge two paths into a single one | Lane merging (two lines into one before a palletizer/sorter) | 3 roller conveyors, 2 chain transfers, capacitive/diffuse sensors, 2 emitters | **Full** | DI 11 (5+6), DO 14 (11+3), Int out 1 |
| 10 | Elevator (Advanced) | Collect up to five items into a stackable box using an elevator | Vertical lift between 4 levels / collecting into totes | Elevator (load/unload rollers, up/down/slow), 4 floor conveyors, per-floor stack lights, warning light | **Full** | DI 20 (14+6; the SDK also lists `Floor 0`–`3` inputs), DO 26 (10+16), Int out 1 |
| 11 | Elevator (Basic) | Transport items through three different levels using two elevators | Mezzanine vertical transport | 2 elevators, 3 levels of conveyors, per-level stack lights | **Full** | DI 30 (24+6), DO 29 (15+14) |
| 12 | Level Control | Control the liquid level (or flow) of a tank using a PID controller | Process control (water treatment, chemical dosing) | Tank (analog: valves 0–10, level and flow meters), setpoint potentiometer, SP/PV displays | Partial: Start/Stop/Reset + lights. **No E-stop.** | DI 3, AI 3 float, DO 3, AO 2 float, Int out 2 |
| 13 | **Palletizer** | Palletize cases in several layers | **End-of-line case palletizing** | Palletizer station (load belt, turner, pusher, plate, clamp, elevator), box feeder belt, pallet feeder/exit roller conveyors, retroreflective/diffuse sensors, warning light, platform | **Full** | DI 14 (8+6), DO 16 (12+4), Int out 1 |
| 14 | Pick & Place (Basic) | Pick and place items from one conveyor into another | Transfer / machine-loading handling | Two-Axis P&P (binary), 2 belt conveyors, 2 diffuse sensors | **Full** | DI 11 (5+6), DO 8 (5+3), Int out 1 |
| 15 | Pick & Place XYZ | Place boxes onto pallets using a three-axis manipulator | Gantry packing/kitting (multi-axis motion) | 3-axis Pick & Place (**analog X/Y/Z setpoints**, C rotation), part/box/exit conveyors, exit status lights | **Full** | DI 10 (4+6), AI 3 float, DO 11 (5+6), AO 3 float, Int out 1 |
| 16 | **Production Line** | Produce the same number of lids and bases by controlling two machining centers | **CNC machine tending**: robots load and unload CNC machines; discrete-part machining | **2 Machining Centers** (CNC + articulated robot + fence + their own untagged switchboard and stack lights), 4 belt conveyors 2 m + 3 belt conveyors 4 m, chute, 4 retroreflective eyes, 4 wheel aligners, 2 raw-material emitters, remover, 2 displays | **None** (must be added) | DI 10 (8 + 2 door), AI 2 int (progress), DO 15, Int out 2 |
| 17 | Separating Station | Separate blue and green parts into two conveyors | Material/colour separation with vision + pushers | 2 vision sensors, 2 pushers (front/back limits), belt conveyors, capacitive/diffuse sensors | Partial: Start/Stop/Reset/E-stop + lights. No Auto/Manual. | DI 12 (8+4), AI 2 int, DO 9 (6+3), Int out 2 |
| 18 | Sorting by Height (Advanced) | Sort cardboard boxes by height using a turntable (compatible with ITS PLC) | Distribution sortation | Roller conveyors, turntable, light array, 6 diffuse sensors, stack light | **Full** + Red/Yellow/Green stack light | DI 18 (12+6), DO 13 (7+6), Int out 1 |
| 19 | Sorting by Height (Basic) | Sort cardboard boxes by height using a chain transfer | Sortation (the current default demo) | Roller conveyors, chain transfer, light array, capacitive, 4 retroreflective | **Full** | DI 14 (8+6), DO 10 (7+3), Int out 1 |
| 20 | Sorting by Weight | Sort cardboard boxes by weight using a conveyor scale | Checkweighing + 3-way diversion | Conveyor scale, pop-up wheel sorter, belt conveyors | **Full** | DI 15 (9+6), AI 1 float, DO 11 (8+3), Int out 4 |
| 21 | Sorting Station | Separate green and blue items using a vision sensor | Vision sortation | Vision sensor, 3 pivot-arm sorters, stop blade, belt conveyors | **Full** | DI 7 (1+6), AI 1 int, DO 12 (9+3), Int out 3 |

### 1.2 Exact tag names per scene

Names are case- and punctuation-exact. "panel6" = `Start`, `Stop`, `Reset`, `Emergency stop`, `Auto`, `Manual`. "lights3" = `Start light`, `Stop light`, `Reset light`.

Idle values follow `factoryio.md` §0, rule 9:

- `Stop` and `Emergency stop` idle TRUE (NC).
- Retroreflective eyes idle TRUE (TRUE = beam clear).
- The selector rests on `Manual`.

**1. From A to B**

- Input: `Sensor` (retro).
- Output: `Conveyor`.

**2. From A to B (Set and Reset)**

- Inputs: `Sensor A`, `Sensor B`.
- Outputs: `Conveyor`, `Entry conveyor`.

**3. Filling Tank (Timers)**

- Inputs: `Fill` (NO), `Discharge` (NC button, idles TRUE).
- Outputs: `Fill valve`, `Discharge valve`, `Filling` (light), `Discharging` (light).
- Int out: `Timer`.

**4. Queue of Items (Counters)**

- Inputs: `At entry`, `At exit`, `Item ready`.
- Outputs: `Entry conveyor`, `Buffer conveyor`.
- Pre-forced: `Emitter`, `Remover`.

**5. Assembler**

- Inputs: `Moving X`, `Moving Z`, `Item detected`, `Lid at place`, `Lid clamped`, `Pos. at limit (lids)`, `Base at place`, `Base clamped`, `Pos. at limit (bases)`, `Part leaving` + panel6.
- Outputs: `Move X`, `Move Z`, `Grab`, `Lids conveyor`, `Clamp lid`, `Pos. raise (lids)`, `Bases conveyor`, `Clamp base`, `Pos. raise (bases)` + lights3.
- Int out: `Counter`.
- Pre-forced: `Lids emitter`, `Bases emitter`, `Remover 1`, `Remover 2`.
- Default Modbus: DI 0–15 = `Moving X`, `Moving Z`, `Item detected`, `Lid at place`, `Lid clamped`, `Pos. at limit (lids)`, `Base at place`, `Base clamped`, `Pos. at limit (bases)`, `Part leaving`, `Start`, `Reset`, `Stop`, `Emergency stop`, `Auto`, `FACTORY I/O (Running)`. Coils 0–11 = `Move X`, `Move Z`, `Grab`, `Lids conveyor`, `Clamp lid`, `Pos. raise (lids)`, `Bases conveyor`, `Clamp base`, `Pos. raise (bases)`, `Start light`, `Reset light`, `Stop light`. HR 0 = `Counter`. `Manual` is not mapped. [OBSERVED export]
- Emitters emit `ProductLidBlue`/`ProductLidGreen` and `ProductBaseBlue`/`ProductBaseGreen` every 1–2 s. [SCENE-FILE]

**6. Assembler (Analog)**

- Inputs: `Item detected`, `Lid at place`, `Base at place`, `Part leaving` + panel6.
- Float in: `X`, `Z`.
- Outputs: `Grab`, `Lids conveyor 1`, `Lids conveyor 2`, `Bases conveyor 1`, `Bases conveyor 2`, `Stop blade 1`, `Stop blade 2` + lights3.
- Float out: `Set X`, `Set Z`.
- Int out: `Counter`.
- Pre-forced: `Lids emitter`, `Bases emitter`, `Lids remover`, `Parts remover`.

**7. Automated Warehouse**

- Inputs: `At Entry`, `At Load`, `At Unload`, `At Exit`, `At Left`, `At Middle`, `At Right`, `Moving X`, `Moving Z` + panel6.
- Outputs: `Entry Conveyor`, `Load Conveyor`, `Unload Conveyor`, `Exit Conveyor`, `Forks Left`, `Forks Right`, `Lift` + lights3.
- Int out: `Target Position`. Cells are 1–54. 0 = hold position. Values above 54 send the crane to the rest/load position 55 [OFFICIAL].
- Pre-forced: `Emitter`, `Remover`.
- Note the capitalised "Conveyor" in names.

**8. Buffer Station**

- Inputs: `At buffer entry`, `At buffer exit`, `At exit` + panel6.
- Float in: `Buffer Vel.` (potentiometer).
- Outputs: `Stop blade` + lights3.
- Float out: `Buffer conveyor`, `Exit conveyor`.
- Int out: `Counter`.
- Pre-forced: `Emitter`, `Remover`.

**9. Converge Station**

- Inputs: `At entry 1`, `At entry 2`, `At transfer 1`, `At transfer 2`, `At exit` + panel6.
- Outputs: `Conveyor 1`, `Conveyor 2`, `Exit conveyor`, `Load 1`, `Unload 1`, `Transfer left 1`, `Transfer right 1`, `Load 2`, `Unload 2`, `Transfer left 2`, `Transfer right 2` + lights3.
- Int out: `Counter`.
- Pre-forced: `Emitter 1`, `Emitter 2`, `Remover`.

**10. Elevator (Advanced)**

- Inputs: `At entry`, `At exit`, `At elevator`, `At 0 (low)`, `At 0 (high)`, `At 1 (low)`, `At 1 (high)`, `At 2 (low)`, `At 2 (high)`, `At 3 (low)`, `At 3 (high)`, `At 1`, `At 2`, `At 3` + panel6. The SDK also lists `Floor 0`–`Floor 3` inputs.
- Outputs: `Load`, `Unload`, `Up`, `Down`, `Slow`, `Conveyor 0`–`Conveyor 3`, `Exit conveyor`, `Warning light`, `Floor 1`–`Floor 3` (lights), `Red 1`–`3`, `Yellow 1`–`3`, `Green 1`–`3` + lights3.
- Int out: `Display`.
- Pre-forced: `Emitter 0`–`3`, `Remover`.

**11. Elevator (Basic)**

- Inputs: `At entry`, `At exit`, `At entry left`, `At exit left`, `At entry right`, `At exit right`, `At entry 0`/`1`/`2`, `At exit 0`/`1`/`2`, `At left low 0`/`1`/`2`, `At left high 0`/`1`/`2`, `At right low 0`/`1`/`2`, `At right high 0`/`1`/`2` + panel6.
- Outputs: `Entry conveyor`, `Exit conveyor`, `Conveyor 0`/`1`/`2`, `Load left`, `Unload left`, `Left up`, `Left down`, `Left slow`, `Load right`, `Unload right`, `Right up`, `Right down`, `Right slow`, `Left warning`, `Right warning`, `Green 0`, `Red 0`, `Yellow 0`, `B green`, `B red`, `B yellow`, `C green`, `C red`, `C yellow` + lights3.
- Pre-forced: `Emitter`, `Remover`.

**12. Level Control**

- Inputs: `Start`, `Stop`, `Reset`.
- Float in: `Level meter`, `Flow meter`, `Setpoint`.
- Outputs: lights3.
- Float out: `Fill valve`, `Discharge valve` (pre-forced in the copies seen).
- Int out: `SP`, `PV`.

**13. Palletizer**

- Inputs: `Box at entry`, `Pallet at entry`, `Pallet at exit`, `Pallet loaded`, `Pusher limit`, `Plate limit`, `Elevator moving`, `Clamped` + panel6.
- Outputs: `Box feeder`, `Load belt`, `Turn`, `Push`, `Clamp`, `Open plate`, `Elevator up`, `Elevator down`, `Move to limit`, `Load pallet`, `Pallet feeder`, `Exit conveyor`, `Warning light` + lights3.
- Int out: `Counter`.
- Pre-forced: `Parts emitter` (palletizing boxes, every 1 s), `Pallets emitter` (square pallets), `Remover`.
- Default Modbus (from a 2.5.4 copy):
  - DI 0 `Pallet at entry`, 1 `Pallet at exit`, 2 `Pallet loaded`, 3 `Box at entry` [INFERRED], 4 `Pusher limit`, 5 `Plate limit`, 6 `Clamped`, 7 `Elevator moving`, 8 `Start`, 9 `Reset`, 10 `Stop`, 11 `Emergency stop` [INFERRED], 12 `Auto`, 13 `FACTORY I/O (Running)`.
  - Coils 0–15: `Pallet feeder`, `Load pallet`, `Exit conveyor`, `Move to limit`, `Elevator up`, `Elevator down`, `Box feeder`, `Turn`, `Push`, `Load belt`, `Clamp`, `Open plate`, `Warning light`, `Start light`, `Reset light`, `Stop light`.

**14. Pick & Place (Basic)**

- Inputs: `Item at entry`, `Item at exit`, `Item detected`, `Moving X`, `Moving Z` + panel6.
- Outputs: `Entry conveyor`, `Exit conveyor`, `Move X`, `Move Z`, `Grab` + lights3.
- Int out: `Counter`.
- Pre-forced: `Emitter`, `Remover`.

**15. Pick & Place XYZ**

- Inputs: `Detected`, `C limit`, `Box at place`, `Part at place` + panel6.
- Float in: `X`, `Y`, `Z`.
- Outputs: `Grab`, `C +`, `Part conveyor`, `Box conveyor`, `Exit conveyor`, `Exit green`, `Exit red`, `Exit yellow` + lights3.
- Float out: `SP X`, `SP Y`, `SP Z`.
- Int out: `Counter`.
- Pre-forced: `Box emitter`, `Part emitter`, `Box remover`.

**16. Production Line**: see §4.1.6 for the full table with Modbus addresses and GUIDs.

- Inputs: `Lids at entry`, `Lids center (busy)`, `Lids center (has error)`, `Lids at exit`, `Bases at entry`, `Bases center (busy)`, `Bases center (has error)`, `Bases at exit`, `Machining Center 1 (Opened)`, `Machining Center 2 (Opened)`.
- Int in: `Machining Center 1 (Progress)`, `Machining Center 2 (Progress)`.
- Outputs: `Lids raw conveyor`, `Lids center (produce lids)`, `Lids center (start)`, `Lids center (stop)`, `Lids center (reset)`, `Lids exit conveyor 1`, `Lids exit conveyor 2`, `Bases raw conveyor`, `Bases center (produce lids)` (sic: FALSE means "make bases"), `Bases center (start)`, `Bases center (stop)`, `Bases center (reset)`, `Bases exit conveyor 1`, `Bases exit conveyor 2`, `Exit conveyor`.
- Int out: `Lids counter`, `Bases counter`.
- Pre-forced: `Lids emitter`, `Bases emitter` (both `RawMaterialBlue`), `Remover`, and probably `Lids center (produce lids)`.
- The SDK sample references `Lids center (running)` and `Bases center (running)`. Neither exists in 2.4.3–2.5.10 scene files, so ignore them.

**17. Separating Station**

- Inputs: `Sensor 1`, `Sensor 2`, `Pusher 1 front`, `Pusher 1 back`, `Pusher 2 front`, `Pusher 2 back`, `At pusher 1 exit`, `At pusher 2 exit`, `Start`, `Stop`, `Reset`, `Emergency stop`.
- Int in: `Vision sensor 1`, `Vision sensor 2`. Values: 1 = blue, 4 = green (raw material); community also gives grey/metal = 7.
- Outputs: `Entry conveyor 1`, `Entry conveyor 2`, `Conveyor 1`, `Conveyor 2`, `Pusher 1`, `Pusher 2` + lights3.
- Int out: `Counter 1`, `Counter 2`.
- Pre-forced: `Emitter 1`, `Emitter 2`, `Remover 1`, `Remover 2`.

**18. Sorting by Height (Advanced)**

- Inputs: `At entry`, `At turntable entry`, `At load position`, `At unload position`, `At front`, `At back`, `At left entry`, `At left exit`, `At right entry`, `At right exit`, `High box`, `Low box` + panel6.
- Outputs: `Feeder conveyor`, `Entry conveyor`, `Load`, `Unload`, `Turn`, `Left conveyor`, `Right conveyor` + lights3, plus `Red indicator`, `Yellow indicator`, `Green indicator`.
- Int out: `Counter`.
- Pre-forced: `Emitter 1 (Emit)`, `Remover left`, `Remover right`.

**19. Sorting by Height (Basic)**: see `factoryio.md` §4.2. The full table with GUIDs is there.

**20. Sorting by Weight**

- Inputs: `At scale`, `At scale entry`, `At scale exit`, `At exit left`, `At exit right`, `At exit front`, `At left entry`, `At right entry`, `At forward entry` + panel6.
- Float in: `Weight`.
- Outputs: `Entry conveyor`, `Load scale`, `Send forward`, `Send left`, `Send right`, `Left conveyor`, `Right conveyor`, `Front conveyor` + lights3.
- Int out: `Weight` (display), `Forward count`, `Right count`, `Left count`.
- Pre-forced: `Emitter`, and `Remover` ×3 (same name).

**21. Sorting Station**

- Inputs: `At exit` + panel6.
- Int in: `Vision sensor`.
- Outputs: `Entry conveyor`, `Exit conveyor`, `Stop blade`, `Sorter 1 turn`, `Sorter 1 belt`, `Sorter 2 turn`, `Sorter 2 belt`, `Sorter 3 turn`, `Sorter 3 belt` + lights3.
- Int out: `Counter 1`, `Counter 2`, `Counter 3`.
- Pre-forced: `Emitter`, `Remover 1`–`3`.

---

## 2. Parts library relevant to manufacturing

The docs group parts into **items, heavy load, light load, sensors, operators, stations, warning devices, walkways**, plus **Emitter/Remover**. [OFFICIAL extract]

**Prefab** below is the `PrefabName` in the scene XML. **Default tag** is the name a freshly dropped part gets; `#` is the instance number. [SCENE-FILE, from 30+ scene files]

### 2.1 Stations (the "machines")

| Part (prefab) | Real-world analogue | Control interface (default tags) | Notes for MongoMation |
|---|---|---|---|
| **Machining Center** (`MachiningCenter`) | CNC machining cell **with its own articulated robot** that loads blanks from an entry bay and unloads finished parts to an exit bay. It comes with a safety fence, its own switchboard (E-stop/Start/Stop/Reset) and 2 stack lights. | Out: `Machining Center # (Produce Lids)`, `(Start)`, `(Stop)`, `(Reset)`. In: `(Is Busy)`, `(Has Error)`, `(Opened)` (CNC door open), `(Progress)` (Int 0–100). | Turns raw material into lids (`Produce Lids`=TRUE) or bases (FALSE). Machining takes 6 s for lids and 3 s for bases [OFFICIAL]; measured `busy` lasts 35.0 s and 32.0 s per part [OBSERVED]. `Has Error` means an invalid item is at the entry bay; the red light comes on and Reset restores it [OFFICIAL]. **The fence switchboard's buttons are not tags** [community]. Its Stop "halts robot and CNC; Start or Reset restarts" [OFFICIAL]; a community thread complains that Reset can restart it [OBSERVED]. Edge- vs level-triggering is [UNVERIFIED]. |
| **Two-Axis Pick & Place** (`TwoAxisPickNPlace`; modes Binary / DA / Analog) | Pneumatic/servo gantry pick-and-place | Binary mode: `Two-Axis Pick & Place # X`, `… Z`, `… (Grab)`, `… (Moving X)`, `… (Moving Z)`, `… (Detected)`. Rotation: `… Rotate CW`/`CCW`, `… (Rotating)`, `… Gripper CW`/`CCW`, `… (Gripper Rotating)`. | Binary mode suits our primitives. Analog mode needs position control. |
| **Pick & Place** (3-axis, `PickNPlace`; Analogue mode) | Cartesian gantry robot (X/Y/Z plus C rotation) | X/Y/Z setpoints and positions (Float), `(C Limit)`, `C(+)`, Grab, Detected | Needs multi-axis setpoint logic. **Not in our primitives yet.** |
| **Stacker Crane + Rack** (`StackerCrane`, `Rack`; Numerical or Digital mode) | AS/RS stacker crane | `Stacker Crane # Target Position` (Int 1–54; 0 = stop; >54 = rest 55), `… Moving-X`, `… Moving-Z`, `… Left Limit`, `… Middle Limit`, `… Right Limit`, `… (Left)`, `… (Right)`, `… Lift` | In Digital mode the cell number is encoded on 5 bits [OFFICIAL]. Numerical mode is simplest. |
| **Palletizer** (`Palletizer`) | Layer (high-level) palletizer | Out: `Turn`, `Push`, `Elevator up`, `Move to limit`, `Elevator down`, `Clamp`, `Open plate`, `Load belt`, `Load pallet`. In: `Plate limit`, `Pallet loaded`, `Elevator moving`, `Pusher limit`, `Clamped`. | 3 interlocked sub-sequences |
| **Elevator** | Vertical lift / elevator conveyor | `Up`, `Down`, `Slow`, `Load`, `Unload` + level sensors | Logistics only |
| **Tank** (`Tank`; Binary or Analog mode) | Process tank with fill and discharge valves | Binary: `Fill valve`, `Discharge valve`, no level signal. Analog: valves 0–10, `Level meter`, `Flow meter`. | You cannot fill items; the tank is standalone. |

### 2.2 Material handling

**Heavy load** (slow, wide, robust) [OFFICIAL list]:

| Part | Prefab | Default tags |
|---|---|---|
| Roller Conveyor 2/4/6 m | `RollerConveyor2M`/`4M`/`6M` | `Roller Conveyor (4m) #` |
| Curved Roller Conveyor | `CurvedRollerConveyor` | `… CW`/`CCW` |
| Loading Conveyor | `LoadingConveyor` | |
| Roller Stop | `RollerStop` | |
| Free Roller | | |
| Chain Transfer | `ChainTransfer` | `Load`, `Unload`, `Transfer left`, `Transfer right` |
| Turntable | `Turntable` | `Turntable # Roll (+)`, `(Limit 0)`, `(Limit 90)`, `(Front Limit)`, `(Back Limit)` |
| Chute Conveyor Low | `ChuteConveyorLow` | |

**Light load** (fast) [OFFICIAL list]:

| Part | Prefab | Default tags / modes |
|---|---|---|
| Belt Conveyor 2/4/6 m | `BeltConveyor2M`/`4M`/`6M` | Modes: SingleBinary, DoubleBinary, Analogue |
| Curved Belt Conveyor | `CurvedBeltConveyor` | |
| Belt Conveyor Inclined | `BeltConveyorInclined` | `(+)`/`(-)` |
| Conveyor Scale | `ConveyorScale` | 0–20 kg mode |
| Pivot Arm Sorter | `PivotArmSorter` | `Turn`, `Belt (+)`/`(-)` |
| Pop-Up Wheel Sorter | `PopUpWheelSorter` | `(Left)`, `(Right)`, `(+)` |
| Pusher | `Pusher` (monostable) | `Pusher #`, `(Front Limit)`, `(Back Limit)` |
| Stop Blade | `StopBlade` | `Stop Blade #` |
| Positioning Bars | `PositioningLeftBar`, `PositioningRightBar` | `Right Positioner # (Raise)`, `(Clamp)`, `(Limit)`, `(Clamped)`: a **clamping fixture** |
| Aligners and others | `Aligner2`/`Aligner3`, `WheelAligner`, `ChuteConveyor`, `Bracket`, `MetalCorner` | |

### 2.3 Sensors [OFFICIAL list]

| Sensor | Prefab | Detects | Notes |
|---|---|---|---|
| Diffuse photoelectric | `DiffusePhotoelectricSensor` | Any solid, 0–1.6 m | TRUE = present |
| Retroreflective + mirror | `RetroreflectivePhotoelectricSensor` | Beam break, 0–6 m [UNVERIFIED range] | **TRUE = beam clear** in all scenes seen |
| Capacitive | `CapacitiveSensor` | Any material, ≤0.2 m | Digital or analog |
| Inductive | | **Metal only**, ≤0.1 m | Detects `RawMaterialMetal`: material verification |
| Light Array (light curtain) | `LightCurtainEmitter`/`Receiver` | 8 beams | Height measurement |
| **Vision Sensor** | `VisionSensor` | Item type | Numeric mode returns an Int ID (raw material blue=1, green=4, grey/metal=7 per community). Binary modes such as "DetectsBlueLids", "DetectsGreenRawMaterial" and "DetectsBlueBases" [SCENE-FILE]. |
| RFID Reader | | Read/write item IDs | **Traceability** use case [OFFICIAL list; behaviour not researched] |
| Incremental Encoder | | | |

### 2.4 Operators, warning devices, safety

**Operators** (`ElectricSwitchboard` + `Column`):

| Part | Prefab | Default tags | Notes |
|---|---|---|---|
| Start push button | `StartPushButton` | `Start Button #`, `Start Button # (Light)` | NO |
| Stop push button | `StopPushButton` | `Stop Button #`, `(Light)` | **NC** |
| Reset push button | `ResetPushButton` | `Reset Button #`, `(Light)` | |
| Emergency stop | `EmergencyStopButton` | `Emergency Stop #` | NC, latching mushroom |
| Generic NO/NC push buttons | | | Since 2.5.6 |
| Light indicators | `RedLightIndicator`, `GreenLightIndicator`, … | `Light Indicator (Red) #` | |
| Selector | `Selector` | `Selector # (State 0)`/`(State 1)` | |
| Potentiometer | `Potentiometer` | | 0–10 V |
| Digital Display | `DigitalDisplay` | `Digital Display #` | Int or 0–10 V |

**Warning devices:** Stack Light (`VisualStatusIndicator` [INFERRED]; tags renamed in built-in scenes to `Red indicator`, `Yellow indicator`, `Green indicator`), Warning Light (`WarningLight`), Alarm Siren.

**Walkways/safety:**

- Safeguards S/L/I (fencing), platforms, stairs, handrails.
- **Safety Door** (`SafetyDoor`): a door with a built-in hinge interlock switch, exposing one Bool input `Safety Door #` for **door closed**. [OFFICIAL extract + SCENE-FILE] This is a ready-made **guard-door interlock** for machine-tending stories.

### 2.5 Items and Emitter/Remover

**Items** [OFFICIAL + SCENE-FILE XML names]:

| Item | XML name(s) | Weight |
|---|---|---|
| Small/Medium/Large box | `BoxS`, `BoxM`, `BoxL` | |
| Palletizing box | `PalletizingBox` | 3 kg |
| **Raw material** | `RawMaterialBlue`, `RawMaterialGreen`, `RawMaterialMetal` | Plastic 8 kg, metal 10 kg |
| **Product lid** | `ProductLidBlue`/`Green`/`Metal` | Plastic 5 kg, metal 7 kg |
| **Product base** | `ProductBaseBlue`/`Green`/`Metal` | Plastic 7 kg, metal 9 kg |
| **Final product** | Lid + base, assembled | |
| Pallet | `Pallet` | 20 kg |
| Square pallet | `SquarePallet` | |
| Stackable box | `StackableBox` | 15 kg; carries raw material, lids and bases |

The manufacturing chain the item set supports is: **raw material → Machining Center → lid or base → assembly → final product → palletizing/storage**.

**Emitter:**

- Options: base (Pallet / SquarePallet / StackableBox / None), part (any item above), `MinTimeToEmit`/`MaxTimeToEmit`, `UpTo` (count), and random position/orientation.
- No new item is emitted while one is still inside the emitter volume.
- The tag is `Emitter # (Emit)`.
- The part and base can be chosen through bit-mapped controller tags. [OFFICIAL extract; tag names UNVERIFIED]

**Remover:** `Remover # (Remove)`. Built-in scenes ship emitters and removers **pre-forced TRUE**.

### 2.6 Custom manufacturing cells you could build, with realistic effort

Effort assumes someone who has added parts in the Factory I/O editor before, and includes Modbus mapping and a smoke test. [ESTIMATE]

| Option | What to add | Effort | Verdict |
|---|---|---|---|
| **A. Panel retrofit on Production Line** | Electric Switchboard + Column, Start/Stop/Reset buttons (their lights are built in), Emergency Stop, a Stack Light. Rename tags; map them to DI 9–12 and Coils 15–20. | **20–30 min** | **Recommended (#1)** |
| B. A + Safety Door | Insert one `SafetyDoor` near a cell and map `Safety Door 1` to DI 13. The machining center fence belongs to the prefab, so the door is a stand-alone interlock. | +10 min | Optional "guard door" requirement |
| C. "Wrong material" physical fault | Add `BoxS` (or `RawMaterialMetal`) to the Lids emitter's part list so that an invalid item occasionally reaches the entry bay and *really* raises `has error` | 5–10 min | [UNVERIFIED] which items count as invalid. Nice-to-have for realism. |
| D. Single CNC machine-tending cell from scratch | `MachiningCenter`, emitter (`RawMaterialBlue`) + 2 m belt conveyor into the entry bay + retro eye at the bay, exit chute/conveyor + eye + remover, switchboard (4 buttons) + stack light | **45–75 min**. Aligning the infeed conveyor to the prefab's entry bay is the fiddly part; copying the cell from the Production Line is easier [UNVERIFIED copy/paste]. | Good fallback if two cells feel too slow or complex. Students have built this (legsano, 2.4.3). |
| E. Machining → assembly mini-line | Production Line + Two-Axis P&P + 2 positioning bars + conveyors (as students did: UFSC 2.5.5, Ahmedhh1218 2.5.4) | 2–4 h + much harder control | Not for a hackathon |
| F. Batch tank | Level Control + E-stop + 2 lamps; threshold logic instead of PID | 20–30 min | Weak visuals and no product made |

---

## 3. Feasibility for our demo: the strongest six manufacturing candidates

| Criterion | **Production Line + panel** | **Assembler** | **Palletizer** | Automated Warehouse | Custom single CNC cell (D) | Pick & Place (Basic) |
|---|---|---|---|---|---|---|
| Visual impact (3D) | ★★★★★ 2 CNCs, 2 orange 6-axis robots in fenced cells, doors open/close, progress | ★★★★ red gantry, clamps, lids landing on bases | ★★★★ big machine, layers of cases build up | ★★★★ crane racing to rack cells | ★★★★ one robot cell | ★★★ gantry moving parts |
| "We're making something" | ★★★★★ raw stock machined into parts | ★★★★ two parts assembled into a product | ★★★ packaging finished goods | ★★ storage | ★★★★★ | ★★ transfer only |
| Operator panel | **No** (add one, ~20 min) | Full | Full | Full | Built as part of the cell | Full |
| Digital vs analog | Digital. Ints only for counters and optional progress. | All digital | All digital | Digital + 1 Int setpoint (`Target Position`) | Digital | All digital |
| Sequence complexity for an LLM [ESTIMATE] | **Medium-low.** The robot and CNC sequence internally. Per cell: feed → wait → count, plus latches and timers. Write one FB, instantiate it twice. 1–3 attempts for the core. | **Medium-high.** ~10 lid steps + 3 base steps, coupled through X/Z edges. 2–5 attempts. | **High.** Pallet supply + layer forming (alternating 2/3 rows with Turn) + clamp/drop/elevator steps, with edge-sensitive limits. 4–8+ attempts. | Medium. 8-step linear sequence plus a cell counter. 2–4 attempts. | Low-medium. 1–2 attempts. | Low-medium. 6 steps. 1–3 attempts. |
| Fit to our test primitives | **Excellent**: seal-in, sensor→actuator (eye→conveyor), interlock (busy blocks infeed), jam/timeout (eyes), fault latch + reset precondition (`has error`), E-stop, counters, balance rule | Good: sequences, interlocks (clamped before descend), timeouts (pick/clamp), counter, E-stop | Good but needs long multi-step sequence assertions | Good; needs an "Int output equals N" assertion | Excellent | Good |
| Realistic faults via Web API | **CNC alarm** (force `… (has error)` TRUE), **infeed jam** (`… at entry` FALSE > 3 s), **outfeed jam** (`… at exit` FALSE), **machine hang** (`… (busy)` stuck TRUE), **starvation** (force `Lids emitter` FALSE), **motor failure** (force `… raw conveyor` FALSE), E-stop | **Missed pick** (`Item detected` Always Off), **dead clamp sensor** (`Lid clamped` Always Off), axis didn't arrive (`Moving X` stuck TRUE), outfeed jam (`Part leaving` stuck), E-stop while gripping | Dead `Clamped` sensor, `Pusher limit` stuck, `Plate limit` dead, `Elevator moving` stuck, no pallet (`Pallet loaded` FALSE), case jam (`Box at entry` blocked) | Crane didn't arrive (`Moving X` stuck), fork not at `At Left`/`At Right`, phantom load (`At Load` stuck), rack full | As Production Line | Missed pick, exit blocked |
| Test duration per run (1×) [OBSERVED cycles] | First real part ~40–45 s after Start (blank arrives 2.1 s, `busy` 35 s). Forcing-based suite ~1.5–2 min. | First product ~9 s, then every ~10 s. Suite ~1–2 min. | Layer ~33 s, pallet ~2 min. Suite 4–6 min. | First box stored ~19 s, then every ~17 s. Suite ~2 min. | ~40 s per part. Suite ~1.5 min. | ~7 s per item. Suite ~1 min. |
| Setup effort (AWS teammate) | **20–30 min** (§4.1.7) | **5–10 min**: save a copy and force `Auto` | 5–10 min | 5–10 min | 45–75 min | ~5 min |

**Other scenes, not recommended for this demo:**

| Scene(s) | Why not |
|---|---|
| Pick & Place XYZ, Assembler (Analog) | Analog multi-axis setpoint control; no primitives yet |
| Level Control | PID and no E-stop |
| Filling Tank | No sensors, so nothing to verify or fault |
| Separating Station, Sorting Station, Sorting by Height/Weight | Sorting; the lead explicitly dislikes it |
| Buffer Station, Converge Station | Accumulation and merging; Buffer uses analog conveyor speeds |
| Elevators | Vertical logistics, many I/O, no product story |
| Queue, From A to B | Training basics |

---

## 4. Top 3 recommendations (ranked)

### 4.1 #1: Production Line as a robot-tended CNC machining cell, with operator panel added

#### 4.1.1 Real-world framing

**Who runs this.** A contract machine shop or Tier-2 supplier (automotive, appliances, electronics enclosures) runs a two-machine CNC cell. Each machine is tended by a robot and makes one half of a mating pair: the **base** (housing) and the **lid** (cover). The pair feeds a downstream assembly line.

**What goes wrong in reality:**

1. **Spindle starvation and blocking.** A machine waits for a blank, or cannot unload because the outfeed is jammed. Every idle minute is lost capacity.
2. **Machine alarms.** Examples are a wrong or missing blank in the fixture, or a part-presence check failing. A naive cell controller stops *everything* and loses the healthy machine's output. Alternatively it keeps pushing blanks into the faulted machine and causes pile-ups.
3. **Imbalance between machines with different cycle times.** In this very scene the lids cell takes ~38 s per part and the bases cell ~35 s. Measured over 28 minutes that gave **48 bases vs 44 lids**. Unmatched parts become WIP that assembly cannot use.
4. **Unsafe restarts.** After an E-stop or reset, automatic restart violates the basic rule that a reset must never start motion. A Factory I/O user raised exactly this about this station.

**Why it matters (sources in §6; numbers indicative):**

- **Unplanned downtime:** Siemens' *True Cost of Downtime 2024* puts it at ~11% of revenue, about $1.4T a year, for the world's 500 largest companies.
- **Machine tending:** widely cited as the leading collaborative-robot application. Vendors report manually tended machines running at only ~60% utilisation.
- **Commissioning:** most time is reportedly spent fixing control-software errors, and virtual commissioning is credited with cutting on-site time by 30–75% (vendor-reported).
- **Workforce:** a 2024 Deloitte/Manufacturing Institute study projects that up to 1.9M of 3.8M US manufacturing jobs could go unfilled through 2033, with machinists named among the fastest-growing roles.

**MongoMation's pitch:** turn the cell's control narrative into tested PLC code in minutes, and prove it against the twin before touching the real cell.

#### 4.1.2 Natural-language spec to type into the demo

> Run the Production Line machining cell: the Lids center turns raw blanks into lids and the Bases center turns them into bases (keep "Lids center (produce lids)" on and "Bases center (produce lids)" off). After Start, run all exit conveyors and feed each center one blank at a time — run its raw conveyor until the blank has passed the entry photo-eye, then stop it and feed the next blank only after the center finishes (busy drops) — counting each finished part on the Lids/Bases counters and pausing whichever center gets 2 parts ahead. If a center reports "has error" or one of its photo-eyes stays blocked for more than 3 s, stop and alarm only that center (red light) while the other keeps running; it resumes only after Reset (which pulses that center's reset) and then Start. Stop lets the parts in progress finish, and Emergency stop immediately stops every conveyor and both centers — nothing restarts until Reset and then Start.

Give the agent the tag dictionary in §4.1.6, including polarity. The eyes are **TRUE when clear**; `Stop` and `Emergency stop` are **NC**.

#### 4.1.3 Testable requirements

`<X>` is `Lids` or `Bases`. Use ≥300–500 ms tolerances because of the 100 ms OpenPLC poll plus scan time.

**R1. Run latch.**

- A Start pulse (≥300 ms) with E-stop healthy and no fault must, within 1 s, set both `<X> center (start)`=TRUE and `(stop)`=FALSE.
- Within the same 1 s, all of `Lids exit conveyor 1`, `Lids exit conveyor 2`, `Bases exit conveyor 1`, `Bases exit conveyor 2` and `Exit conveyor` must be TRUE, and `Start light` TRUE.
- These stay TRUE after Start is released (seal-in).

**R2. Product selection.** While running, `Lids center (produce lids)`=TRUE and `Bases center (produce lids)`=FALSE.

**R3. One blank at a time (feed plus interlock).**

- `<X> raw conveyor` comes ON within 1 s when running and `<X> center (busy)`=FALSE.
- It goes OFF within 0.5 s of `<X> at entry` going FALSE→TRUE (the blank has passed the eye).
- It is **never ON while `busy` is TRUE**.
- It comes ON again within 1 s of `busy` going TRUE→FALSE.

**R4. Counting.** `<X> counter` increases by **exactly 1** on each `<X> center (busy)` TRUE→FALSE edge, and on nothing else.

**R5. Balancing.**

- If `Lids counter − Bases counter ≥ 2`, then `Lids raw conveyor` stays OFF until the gap is ≤1, while the Bases side keeps feeding.
- The same rule applies with the roles swapped.

**R6. Machine alarm (fault latch, isolation, reset precondition).**

When `<X> center (has error)`=TRUE, within 1 s:

- `<X> raw conveyor` goes OFF.
- `<X> center (start)` goes FALSE and `(stop)` TRUE.
- The red light comes ON.
- **The other center's outputs do not change.**

Afterwards:

- The fault stays latched after `has error` clears, and Start alone does not clear it.
- Reset while `has error`=FALSE pulses `<X> center (reset)` (0.5–2 s) and turns the red light OFF.
- Feeding resumes only after a subsequent Start.

**R7. Jam watchdog.**

- Trigger: `<X> at entry` FALSE continuously for more than 3 s while the raw conveyor is commanded, or `<X> at exit` FALSE for more than 3 s.
- Response: the same as R6 for that center, within 4 s of the block starting.
- Normal blocking is ~0.6 s at the entry eye and ~0.5 s at the exit eye [OBSERVED], so 3 s leaves a wide margin.

**R8. Stop and E-stop.**

*Stop:*

- `Stop` (NC → FALSE pulse) turns both raw conveyors OFF within 0.5 s and the `Stop light` ON.
- The exit conveyors keep running until both `busy` are FALSE, then turn OFF within ~5 s.

*E-stop:*

- `Emergency stop`=FALSE turns all 7 conveyors OFF within 0.5 s, sets both `(start)` FALSE and `(stop)` TRUE, and turns the red light ON.
- After E-stop release, everything stays OFF (check for ≥3 s).
- Reset alone starts nothing.
- Reset followed by Start resumes.

**Minimal live subset:** R1, R3, R4, R6 and R8. Keep R5 and R7 as the "self-improvement" round 2.

**Test-harness tips:**

- Most requirements can be proven in seconds by forcing `busy`, `has error` or the eyes, without waiting 35 s machining cycles. Run one real end-to-end part (~45 s) for the visual.
- For pure-logic tests, pause material by forcing `Lids emitter` and `Bases emitter` to FALSE. Re-force them to **TRUE** afterwards; **do not release them**.

#### 4.1.4 Best fault to inject live

**Fault:** a CNC alarm on the Lids center mid-production. Force `Lids center (has error)`=TRUE for ~2 s, then release it. Optionally write `FACTORY I/O (Camera Position)` to the index of `Electric Board (lids)` to zoom in.

**Correct handling:**

1. Within 1 s the Lids raw conveyor stops.
2. `Lids center (stop)`=TRUE and `(start)`=FALSE, so the lids robot freezes in the 3D view.
3. The red stack light comes ON.
4. **The Bases cell keeps producing** (its counter still increments).
5. When the force is released the alarm **stays latched**, and pressing Start does nothing.
6. Pressing Reset pulses `Lids center (reset)` and clears the red light.
7. Pressing Start resumes feeding the lids cell.

**Why this fault:** it is visible, it shows *selective fault isolation*, and it targets typical first-attempt LLM bugs. Each bug is caught by a specific assertion, which gives the repair loop something real to fix:

- stops the whole line (R6 "other center unchanged");
- auto-resumes when the error clears (R6 latch);
- never pulses the machine reset (R6 reset pulse);
- resets from Start (R6/R8).

**Backup live fault:** an infeed jam. Force `Bases at entry`=FALSE for 4 s and expect a latched jam fault on the bases side after 3 s.

#### 4.1.5 What would make this demo fail (risks and mitigations)

1. **Station command semantics are unknown.** It is unverified whether `(start)`, `(stop)` and `(reset)` are edge- or level-triggered.
   - Spec a robust pattern: hold `start`=TRUE and `stop`=FALSE while running; hold `start`=FALSE and `stop`=TRUE when stopped or faulted; pulse `reset` for 0.5–1 s.
   - Verify on the install before the demo (§5, item 1).
2. **Infeed stop point.** The SDK stops the raw conveyor *after* the blank has cleared the eye, and the robot picks 0.3 s later [OBSERVED].
   - Code that stops while the eye is still blocked may leave the blank short of the pick position, and the cell deadlocks with `busy` never rising.
   - R3 catches it. Keep the spec wording "has passed the eye".
3. **Polarity mistakes.** Retro eyes are TRUE when clear; Stop and E-stop are NC. Without polarity in the tag dictionary the LLM will invert logic.
4. **Pre-forced tags.**
   - A cleanup step that "releases all forces" stops blanks (`Lids emitter`, `Bases emitter`) and may flip the Lids center to making bases (`Lids center (produce lids)`).
   - Release only what the harness forced. Snapshot `isForced` at start (`factoryio.md` §5).
5. **OpenPLC writes every mapped coil every poll.** Forgetting the exit conveyors (all FALSE) makes finished parts pile up at the exit bays. The spec names them explicitly.
6. **Exit-eye glitches** (80–90 ms blips) double-count if counting is done on the eye. Count on the `busy` falling edge (R4), or debounce the eye by ≥200 ms.
7. **Slow cycles** of ~38 s per part. Use forcing-based tests and show one real part; do not wait for many.
8. **Forced inputs are invisible in 3D.** The station's own light will not turn red when we force `has error`, so add a stack light and narrate it. Do not click the station's own fence E-stop: it is not a tag and halts the station outside PLC control.
9. **Panel mapping errors.** Panel addresses must match the PLC's located variables. Generate the map from the exported tag CSV and smoke-test each button (force it, then read back via OpenPLC).
10. **Rendering load.** Two robots and two CNCs are heavier than the sorting scene. Check fps on the GPU VM; keep time scale at 1×.

#### 4.1.6 Exact tags, Modbus addresses and OpenPLC addresses for #1

Default layout: [SCENE-FILE 2.5.10, identical to the bonnet export]. GUIDs: [SCENE-FILE], identical in the 2.4.3, 2.5.5 and 2.5.10 copies. OpenPLC device: **DI start 0 size 13, Coils start 0 size 21, IR 0/0 (or 0/2 for progress), HR-read 0/0, HR-write start 0 size 2.**

| Modbus | OpenPLC | Tag (exact) | Kind / type | Meaning / polarity | GUID |
|---|---|---|---|---|---|
| DI 0 | %IX100.0 | `Lids at entry` | Input Bool | Retro eye at the lids infeed bay. **TRUE = clear**, FALSE = blank in beam. | 25bbc8c6-1074-4631-9094-c8bd4cb31382 |
| DI 1 | %IX100.1 | `Lids center (busy)` | Input Bool | TRUE from robot pick to robot release (~35 s) | d998ecdf-9d7a-4408-8c6c-59ba4aa61701 |
| DI 2 | %IX100.2 | `Lids center (has error)` | Input Bool | Invalid item at the entry bay | a59af8a3-9140-4d4f-a8ae-a099270f60b3 |
| DI 3 | %IX100.3 | `Lids at exit` | Input Bool | Retro eye at the lids outfeed. TRUE = clear. | 8ee2808d-3911-48bd-893a-5dc8c9e6c43f |
| DI 4 | %IX100.4 | `Bases at entry` | Input Bool | As DI 0 | ff09e89a-19ef-4754-9a4a-16ae248b4521 |
| DI 5 | %IX100.5 | `Bases center (busy)` | Input Bool | ~32 s per part | ab203ddd-bba8-4ed0-b9a7-235f08fda667 |
| DI 6 | %IX100.6 | `Bases center (has error)` | Input Bool | | fd88e942-1a01-42de-ba48-7e874c7c0df8 |
| DI 7 | %IX100.7 | `Bases at exit` | Input Bool | TRUE = clear | f5f07c50-0ceb-4853-b10c-bd454db16ddb |
| DI 8 | %IX101.0 | `FACTORY I/O (Running)` | Input Bool | Scene in Run mode | (per scene) |
| *DI 9* | %IX101.1 | **`Start`** (added) | Input Bool | NO push button | (new) |
| *DI 10* | %IX101.2 | **`Stop`** (added) | Input Bool | **NC**: TRUE = not pressed | (new) |
| *DI 11* | %IX101.3 | **`Reset`** (added) | Input Bool | NO | (new) |
| *DI 12* | %IX101.4 | **`Emergency stop`** (added) | Input Bool | **NC**: TRUE = healthy | (new) |
| (unmapped) | – | `Machining Center 1 (Opened)` / `Machining Center 2 (Opened)` | Input Bool | CNC door open (TRUE at idle, FALSE while machining) | 76b3350b-d813-45b3-ab82-13107411fd2d / 377c4656-24e1-4963-9dca-25054aef73e2 |
| (unmapped; optional IR 0/1 = %IW100/%IW101) | – | `Machining Center 1 (Progress)` / `Machining Center 2 (Progress)` | Input Int | 0–100 % during machining. Good for a dashboard progress bar via the Web API. | df8464f2-31a4-407e-bf6e-15736d2ba45e / 25f154b6-b59e-42e5-9f1d-da761139ac2d |
| Coil 0 | %QX100.0 | `Lids raw conveyor` | Output Bool | Infeed belt 2 m | 8f8e2add-e082-439c-844f-7d87251e6da8 |
| Coil 1 | %QX100.1 | `Lids center (produce lids)` | Output Bool | TRUE = lids. **Pre-forced TRUE.** | 780ee174-3d6d-4c85-8be7-0e9cc2dda6cf |
| Coil 2 | %QX100.2 | `Lids center (start)` | Output Bool | | 9d220f0f-fc8d-4e75-ad21-93322310d6fa |
| Coil 3 | %QX100.3 | `Lids center (reset)` | Output Bool | | f33dadef-351f-43bd-b413-f4ef299460e5 |
| Coil 4 | %QX100.4 | `Lids center (stop)` | Output Bool | | f3ffe6fa-17f4-4c5d-bb89-ca48b1934961 |
| Coil 5 | %QX100.5 | `Lids exit conveyor 1` | Output Bool | | 076c42b7-8e67-4947-b320-4d20e62a226f |
| Coil 6 | %QX100.6 | `Lids exit conveyor 2` | Output Bool | | 8a2f7ffe-cda1-4cf6-8d27-d61c37a549a8 |
| Coil 7 | %QX100.7 | `Bases raw conveyor` | Output Bool | | 2dafe694-16f2-4535-a07c-c7ae21ffa78e |
| Coil 8 | %QX101.0 | `Bases center (produce lids)` | Output Bool | Must be **FALSE** (makes bases) | 60738442-ba45-4777-810a-b26b9e397d79 |
| Coil 9 | %QX101.1 | `Bases center (start)` | Output Bool | | de4c5de9-6532-471b-9eed-8c217d0814f9 |
| Coil 10 | %QX101.2 | `Bases center (reset)` | Output Bool | | 7958ef6f-5463-436d-b948-97968abdfed9 |
| Coil 11 | %QX101.3 | `Bases center (stop)` | Output Bool | | de5ad9b8-aaf9-41ed-8440-b4416e59544a |
| Coil 12 | %QX101.4 | `Bases exit conveyor 1` | Output Bool | | 44ca972c-6776-4a21-8cd8-18aa175516f6 |
| Coil 13 | %QX101.5 | `Bases exit conveyor 2` | Output Bool | | f9f48cb2-f9c7-4953-ae81-53f685fc05f3 |
| Coil 14 | %QX101.6 | `Exit conveyor` | Output Bool | Merged final conveyor to the remover | fda1d9f6-63c1-4211-8d6e-5d85abe8486b |
| *Coil 15* | %QX101.7 | **`Start light`** (added) | Output Bool | | (new) |
| *Coil 16* | %QX102.0 | **`Stop light`** (added) | Output Bool | | (new) |
| *Coil 17* | %QX102.1 | **`Reset light`** (added) | Output Bool | | (new) |
| *Coil 18* | %QX102.2 | **`Red indicator`** (added stack light) | Output Bool | Fault | (new) |
| *Coil 19* | %QX102.3 | **`Yellow indicator`** (added) | Output Bool | Warning, e.g. starved or holding for balance | (new) |
| *Coil 20* | %QX102.4 | **`Green indicator`** (added) | Output Bool | Running | (new) |
| HR 0 | %QW100 | `Lids counter` | Output Int | Display | a0bee5f8-f527-4b71-b255-977aaa07a543 |
| HR 1 | %QW101 | `Bases counter` | Output Int | Display | f992e7a0-2beb-425c-8a25-22c3fd5df882 |
| (unmapped) | – | `Lids emitter`, `Bases emitter`, `Remover` | Output Bool | **Pre-forced TRUE. Do not release.** | 1a03a741-f3a5-472f-8ca6-bbd264447237, 01487e68-f9b9-44d8-8922-65f02cd8daa3, 1cec3470-8bde-45c5-bc9f-8cd145966912 |

Names in **bold** are added by us, and those names are our recommendation. They follow the built-in scenes' conventions (`Start`, `Stop`, `Reset`, `Emergency stop`, `… light`, `Red/Yellow/Green indicator`). The GUIDs of the added tags are generated by Factory I/O, so resolve them by `(name, kind)` through `GET /api/tags`.

**Measured signal timing (1×, 28-minute run)** [OBSERVED]:

| Signal | Lids cell | Bases cell |
|---|---|---|
| `busy` high | 35.0 s (35.0–35.5) | 32.0 s (32.0–32.5) |
| Idle between parts | ~3.0 s | ~3.0 s |
| CNC door closed (`Opened`=FALSE) | 5.0 s | 2.0 s |
| Raw conveyor ON → blank reaches entry eye | 2.1 s | 2.1 s |
| Entry eye blocked while the blank passes | 0.61 s | 0.61 s |
| Exit eye blocked | 0.52 s | 0.53 s |
| Exit eye block → `busy` falls | 2.2 s | 2.2 s |
| Exit-eye glitches (80–90 ms) | 3 in 44 parts | 0 |

#### 4.1.7 Setup steps for the AWS teammate (~20–30 min)

1. Open **Production Line**, then **File > Save As** "Production Line MM" in My Scenes. Built-in scenes are read-only.
2. Press **F5** to enter Edit mode, then open the Palette and go to **Operators**.
   - Place an Electric Switchboard (with a Column) near the exit conveyor junction.
   - Add Start, Stop, Reset and Emergency Stop buttons.
   - Under Warning Devices, add a Stack Light.
3. Rename the tags exactly as in §4.1.6:
   - `Start Button 1` → `Start`, `Start Button 1 (Light)` → `Start light`, and likewise for Stop and Reset.
   - `Emergency Stop 1` → `Emergency stop`.
   - The stack-light tags → `Red indicator`, `Yellow indicator`, `Green indicator`.
4. Press **F4** and choose **Modbus TCP/IP Server**, then **Configuration**.
   - Keep DI 0–8, Coils 0–14 and HR 0–1 as they are.
   - Drag the new inputs to DI 9–12 and the new lights to Coils 15–20.
   - Optionally drag `Machining Center 1/2 (Progress)` to IR 0–1.
   - **Export tags** to CSV.
5. Check `GET /api/tags`:
   - `Lids emitter`, `Bases emitter` and `Remover` show `isForced=true`, and probably `Lids center (produce lids)` too.
   - Idle values: `Start`=false, `Stop`=true, `Reset`=false, `Emergency stop`=true.
6. Save the scene, then set the OpenPLC slave device sizes as given in §4.1.6.
7. Run the 10-minute checks in §5.

### 4.2 #2: Assembler, a final-assembly cell placing lids onto bases

#### 4.2.1 Real-world framing

**What it is.** A final-assembly station places a cover onto a housing to make a finished product. Typical examples are an electronics enclosure, a container lid, or a battery-module cover. Fixtures clamp both parts and a pick-and-place gantry does the transfer. Throughput is counted per assembled unit.

**What goes wrong in reality:**

- **Missed picks** from vacuum or gripper failure, and **unconfirmed clamps**. These cause misassembly, or the cell **hangs forever waiting for a signal**, and operators reach into the cell to "help" it, which is a safety problem.
- Starved infeeds and blocked outfeeds.
- **E-stop behaviour.** An E-stop must not drop a part held in the gripper; the gripper must fail safe and hold.

**SCAPHY precedent.** In SCAPHY's Pick & Place attack, a single spurious conveyor move caused a grab miss, and the simple controller "hangs waiting for a successful grab". [OBSERVED]

**The demo shows** the AI writing a controller that detects these conditions with watchdogs, retracts safely, and asks for intervention with a latched fault.

#### 4.2.2 Natural-language spec

> Run the Assembler cell in Auto: Start and Stop latch the cycle, and Emergency stop freezes all motion but keeps Grab on so a held lid is never dropped. Run the Lids conveyor until a lid has passed "Lid at place", then stop it and Clamp lid; do the same for bases with the Bases conveyor, "Base at place" and Clamp base. With both clamped, lower the gantry (Move Z) until "Item detected", Grab, unclamp the lid, raise, Move X over the base, lower and release, raise and return; then unclamp the base, raise "Pos. raise (bases)" and run the Bases conveyor until the product clears "Part leaving", adding 1 to Counter. If a clamp is not confirmed within 2 s, or no part is detected within 3 s of lowering, raise the gantry, stop the conveyors and latch a fault (flashing Stop light) that only Reset followed by Start clears.

#### 4.2.3 Testable requirements

The sequence follows the SDK reference logic. Measured step times [OBSERVED]: clamp ~0.75 s, Z travel ~0.8 s, X travel ~1.6 s, cycle ~10 s.

**R1. Mode and latch.**

- The cell runs only when `Auto`=TRUE and `Emergency stop`=TRUE.
- Start latches; Stop unlatches.
- `Start light` reflects the run state.

**R2. Infeed and clamp.** Within 0.3 s of `Lid at place` going TRUE→FALSE, `Lids conveyor` turns OFF and `Clamp lid` turns ON. The same holds for bases.

**R3. Descend interlock.** `Move Z` never turns ON for a pick unless `Lid clamped`, `Base clamped` and `Moving X`=FALSE all hold.

**R4. Grab and release order.**

- `Grab` turns ON only after `Item detected` is TRUE.
- `Clamp lid` turns OFF only after `Grab` is ON.
- `Grab` turns OFF only with the gantry at the base side and Z down.

**R5. Axis interlock.** `Move X` never changes while `Moving Z` is TRUE.

**R6. Outfeed and count.**

- After release and Z up, `Clamp base` turns OFF and `Pos. raise (bases)` and `Bases conveyor` turn ON.
- `Counter` increases by exactly 1 per product leaving, on the `Part leaving` TRUE→FALSE edge.

**R7. Watchdogs.**

- A clamp not confirmed within 2 s, or no `Item detected` within 3 s of a descent, triggers the fault response.
- Response: `Move Z` OFF (retract), conveyors OFF, fault latched, `Stop light` flashing.
- Reset with the cause gone clears the fault; Start is then required.

**R8. E-stop.** All motion outputs go OFF within 0.5 s, `Grab` keeps its value, and Reset plus Start is required.

#### 4.2.4 Best fault to inject

**Fault:** a missed pick. Apply an Always-Off failure (or force FALSE) to `Item detected` while the gantry descends.

**Correct handling:**

1. Within 3 s the gantry retracts (`Move Z` OFF).
2. The conveyors stop and the fault latches with a flashing `Stop light`.
3. `Move X` **never** fires with nothing gripped.
4. `Counter` is unchanged.
5. After the failure is cleared, Reset followed by Start retries the pick, and the next assembly completes.

**Why it reads well on screen:** the gripper dips, comes back up empty, and the cell stops with a flashing light.

**Alternative fault:** a dead clamp sensor. Apply Always Off to `Lid clamped`; the gantry must not descend, and the fault comes after 2 s.

#### 4.2.5 Risks

- **Auto selector.** The selector rests on `Manual`. Force `Auto`=TRUE and `Manual`=FALSE during tests, or turn the selector in the UI. `Manual` is not in the default Modbus map.
- **Coupled sequence.** The lids and bases sub-sequences are coupled, and the X/Z feedback is edge-based (the falling edge of `Moving Z` means "arrived"). Expect 2–5 attempts. Watchdog timeouts turn hangs into readable failures.
- **Positioner semantics.** `Pos. raise (bases)` with `Pos. at limit (bases)` lets the assembled part leave. If the LLM never raises the positioner, products pile up. R6 catches it.
- **Supply pressure.** Lids and bases arrive every 1–2 s from pre-forced emitters, so queues build against the positioners. That is fine, but do not release the emitters.
- **E-stop and Grab.** Check how the station behaves when `Grab` stays TRUE with motion stopped. [UNVERIFIED]

### 4.3 #3 (stretch): Palletizer, end-of-line case palletizing

**Safer alternative for #3:** Automated Warehouse (AS/RS); see §4.3.6.

#### 4.3.1 Real-world framing

**What it is.** A layer palletizer at the end of a food, beverage or consumer-goods line stacks cases into an interlocked pattern and wraps them for shipping.

**What goes wrong in reality:**

- **Single point of failure.** When the palletizer stops, accumulation fills and the whole upstream line stops.
- **Unstable loads.** A layer dropped without being clamped, or a mis-stacked pattern, produces unstable pallets and transit damage.
- **Manual palletizing injuries.** Manual palletizing drives musculoskeletal injuries: NIOSH links manual palletizing to low-back disorders, and vendor-cited BLS data counts more than 255k US overexertion injuries from lifting in 2022.

**Why it suits the demo:** strong interlocks such as "never open the plate unless the layer is clamped" and "never push while the elevator moves".

#### 4.3.2 Natural-language spec

> Run the Palletizer at the end of the line: keep an empty pallet on the elevator (run Pallet feeder and Load pallet until "Pallet loaded", then raise it with Elevator up and Move to limit). Build each layer from 6 cases: run Box feeder and Load belt, count cases at "Box at entry", Push a row onto the plate after 2 cases (after 3 cases with Turn on, on alternate layers), then Clamp, Open plate to drop the layer, unclamp and lower the elevator one layer; after 3 layers lower to the bottom, send the pallet out with Load pallet and Exit conveyor, add 1 to Counter and load a new pallet. Keep the Warning light on while the elevator moves; if "Clamped", "Pusher limit" or "Plate limit" is not reached within 3 s, stop and latch a fault until Reset and Start, and Emergency stop halts everything.

#### 4.3.3 Requirements

The layer pattern and sequence come from the SDK reference. [OFFICIAL SDK]

**R1. Panel.** Start/Stop/E-stop with `Auto`.

**R2. Pallet supply.** `Pallet feeder` and `Load pallet` stay ON until `Pallet loaded`, then turn OFF.

**R3. Row forming.**

- Each `Box at entry` passage increments the case count.
- A row is pushed after 2 cases (`Turn` OFF) or 3 cases (`Turn` ON), alternating by layer.

**R4. Push interlock.**

- `Push` is never ON while `Elevator moving` is TRUE.
- `Push` ends on the `Pusher limit` rising edge.

**R5. Layer drop.**

- `Open plate` never turns ON unless `Clamped` is TRUE.
- The clamp releases after `Plate limit`.
- The elevator then steps down one layer, with `Warning light` ON while it moves.

**R6. Pallet out and count.** After 3 layers, the pallet exits and `Counter` increases by exactly 1.

**R7. Watchdogs.** `Clamped`, `Pusher limit` and `Plate limit` each have a 3 s watchdog that latches a fault.

#### 4.3.4 Best fault

**Fault:** a dead clamp sensor (Always Off on `Clamped`).

**Correct handling:**

- The layer stays on the closed plate, because opening without a confirmed clamp would collapse the layer.
- The fault latches after 3 s and case feeding stops.
- After the failure is cleared, Reset followed by Start completes the layer drop.

#### 4.3.5 Risks

- **Highest complexity.** There are three concurrent sequences, plus semantics the LLM must be told: `Move to limit`, the `Elevator moving` edges, `Pusher limit` firing at both ends, and the `Turn` timing. Expect many repair iterations.
- **Long tests.** A layer takes ~33 s and a pallet ~2 min, so the suite runs 4–6 min.
- **The pitch is weaker.** It is packaging rather than making.
- **Recommendation:** only attempt this after #1 works. Optionally scope it to "form and drop one layer".

#### 4.3.6 Safer alternative #3: Automated Warehouse (AS/RS)

**Spec:**

> Store each incoming box: when a box reaches the load position (At Load becomes FALSE), stop Entry Conveyor and Load Conveyor, extend Forks Left until At Left, Lift, retract until At Middle, set Target Position to the next free cell (1–54), wait for the crane to stop moving, extend Forks Right until At Right, lower, retract to At Middle and return to Target Position 55. Count stored boxes, show a full-rack light at 54, and latch a fault if any fork or crane move takes longer than 5 s or 10 s.

**Characteristics:**

- 8 linear steps, ~17 s per box [OBSERVED], full panel.
- Best fault: "crane did not arrive" (force `Moving X`=TRUE beyond 10 s).
- Weakness: the story is logistics rather than manufacturing.
- Reference ST exists: legsano `Auto_Wherehouse/AWH.st`.

---

## 5. Open questions: a 10-minute verification checklist on the real install

**1. Machining Center command semantics** (most important for #1).

- **Setup:** keep the Modbus driver disconnected, or keep OpenPLC stopped. Then the Web API **force** verbs below control the station directly.
- **a.** Force `Lids center (start)`=TRUE. Does the robot pick a waiting blank? `busy` should rise.
- **b.** While it is running, pulse `(stop)`=TRUE for 1 s with `start` still TRUE. Does it stay stopped (edge-triggered) or resume immediately (level-triggered)?
- **c.** Pulse `(reset)`. Does the robot resume motion?
- **d.** Hold `start`=FALSE and `stop`=TRUE, then raise `start` and drop `stop`. Does it resume?
- **Record the results** and adjust R1, R6 and R8 wording if needed.

**2. Pre-forces.** In your saved copy, check `isForced` for `Lids emitter`, `Bases emitter`, `Remover` and `Lids center (produce lids)`.

**3. Infeed stop point.** Force `Lids raw conveyor` ON. Stop it (a) while `Lids at entry` is still FALSE, and (b) after it returns TRUE. Does the robot pick in both cases?

**4. Visual effect of forcing `Lids center (has error)`.** Expect no change on the station light, so add our own stack light.

**5. Camera switching.** Find the index of `Electric Board (lids)` for `FACTORY I/O (Camera Position)` (0- or 1-based).

**6. Panel polarity.** Check the idle values of the added buttons. Stop and E-stop should idle TRUE. Push-button lights are separate Output tags.

**7. Frame rate and cycle time.** Measure fps and cycle time on the AWS GPU VM at time scale 1. Expect ~38 s per lid and ~35 s per base.

**8. (Optional) Invalid items.** Which emitter items make `has error` fire for real? Try `BoxS` or `RawMaterialMetal` in the Lids emitter's part list.

---

## 6. Sources

### Official (via search-engine extracts; the domains are blocked here)

- Scenes index (21 scenes, objectives): https://docs.factoryio.com/manual/scenes/
- Production Line scene: https://docs.factoryio.com/manual/scenes/production-line/
- Assembler scene: https://docs.factoryio.com/manual/scenes/assembler/
- Pick & Place XYZ scene: https://docs.factoryio.com/manual/scenes/pick-and-place-xyz/
- Stations covers the following:
  - Machining Center: tags, 6 s / 3 s machining, Has Error, panel behaviour, E-stop reset.
  - Stacker Crane: Target Position 1–54, 0 = stop, >54 = rest 55; Numerical and Digital modes.
  - Palletizer and Pick & Place.
  - https://docs.factoryio.com/manual/parts/stations/
- Parts index (categories): https://docs.factoryio.com/manual/parts/
- Heavy load: https://docs.factoryio.com/manual/parts/heavy-load/
- Light load: https://docs.factoryio.com/manual/parts/light-load/
- Items (raw material, lid, base, weights): https://docs.factoryio.com/manual/parts/items/
- Sensors: https://docs.factoryio.com/manual/parts/sensors/
- Walkways (Safety Door): https://docs.factoryio.com/manual/parts/walkways/
- Emitter: https://docs.factoryio.com/manual/parts/emitter/
- Release notes (2.3.0 Machining Center error and reset, 2.5.x): https://docs.factoryio.com/release-notes/
- Official SDK, with one controller per built-in scene (`samples/Controllers/Scenes/*.cs`): https://github.com/realgamessoftware/factoryio-sdk

### Community (via search extracts)

- Machining Center reset and E-stop concerns; no tag on the station E-stop: https://community.factoryio.com/t/a-reset-should-never-start-a-machine-safety-concerns/697
- Production Line as a robot-tending-CNC model: https://community.factoryio.com/t/real-world-examples-of-a-factory-io-production-line-scene/878
- How to program Machining Center: https://community.factoryio.com/t/how-to-program-machining-center/1711
- Machine Center Progress data type: https://community.factoryio.com/t/machine-center-progress-at-production-line/2300
- Vision sensor values: https://community.factoryio.com/t/documentation-vision-sensor/4538
- Stacker crane discussion: https://community.factoryio.com/t/stacker-crane-upgrade-discussion/4214
- Emitter timing: https://community.factoryio.com/t/how-to-delay-an-emitter/258
- OpenPLC forum, Production Line in FBD: https://openplc.discussion.community/post/production-line-scene-from-factory-io-fbd-11657885

### Primary artifacts read directly

**lordmoses/SCAPHY** (`Physical-Process/ALL_TRAIN_AND_TEST_DATA/…`):

- `ATTACK-AND-BENIGN-DATA/*/…CycleValues.arff`: full tag headers for all 21 scenes, plus timings.
- `MODELING -DATA/ProductionLine/2021-10-13--18-18-35_CycleValues.txt`: the 28-minute run.
- `MODELING -DATA/Palletizer/2021-11-01--15-27-16_CycleValues.arff`: layer timing.
- `Testbed-Info-RTU-Emulation-FactoryIO/ICS-Scenarios.rtf`: per-scene attack notes.
- `HMI-screenshots/*.PNG`: Production Line, Assembler, Palletizer, Pick & Place, Separating Station.
- Repository: https://github.com/lordmoses/SCAPHY

**Production Line scene XML:**

- spartajaden/smart-factory-data-analysis `modbus_robot.factoryio`: saved by **2.5.10**; tags, GUIDs, Modbus map, cameras.
- geovanneaoliveira/UFSC `Modelagem de Sistemas Discretos/CodeIO/BLU3504_TA2_2023-1.factoryio`: 2.5.5; pre-forced `produce lids` and emitters; extended with an assembler and panel.
- Faaizz/tuk_project `src/virtual_factories/Old/sec_A.factoryio`: 2.4.3; pre-forced `produce lids`; default `Machining Center # (…)` tag names.

**Other scene XML** (prefab and default-tag catalog):

- legsano/FactoryIO-OpenPLCEditor: `Scenes_FactoryIO/*.factoryio`, **OpenPLC ST** `Production_Line/PL.st` and `Auto_Wherehouse/AWH.st`.
- Asoomkamel/Automated-production-Line-with-Integrated-Warehouse: `Final.factoryio`.
- Ahmedhh1218/TIA-FACTORY-IO-Production-Line-Automation: `Production-Line-Scene.factoryio`.
- Hesham-Hesham/Automated-Production-Line-Simulation.
- VRomanov89/SolisPLC_Development.
- MohamedAzizChouaibi/BISCUIT-FACTYORY-USING-TIA_PORTAL.
- lmtriwork/Factoryio-Projects: copies of the built-in scenes, 2.2.2–2.5.4.

**Production Line controllers:**

- nesfit/bonnet-ics-library: `imadics/source/ModbusFactory/Controllers/ProductionLineController.cs` and `Scenes/Tags_ProductionLine_Modbus.csv`, the default Modbus export.
- unaxiee/REVIVER: `Scenes/ProductionLine.cs`.

### Industry context (indicative; mostly vendor or secondary)

- Siemens, *The True Cost of Downtime 2024* (11% of revenue, ~$1.4T for the Fortune Global 500): https://assets.new.siemens.com/siemens/assets/api/uuid:1b43afb5-2d07-47f7-9eb7-893fe7d0bc59/TCOD-2024_original.pdf
- Deloitte and The Manufacturing Institute, 2024 (3.8M jobs needed by 2033, 1.9M may go unfilled): https://www2.deloitte.com/us/en/pages/about-deloitte/articles/press-releases/us-manufacturing-could-need-new-employees-by-2033.html
- Machine tending:
  - Universal Robots (machine tending as a "dull, dirty, dangerous" job): https://www.universal-robots.com/blog/the-business-benefits-of-machine-tending-with-collaborative-robots/
  - Robotiq (machine tending as the top cobot application): https://blog.robotiq.com/cncs-in-decline-nope.-manufacturers-are-getting-smart
  - EVS (utilisation in the low 60s → 85%+, vendor estimate): https://www.evsint.com/robotic-cnc-machine-tending-one-operator-multi-machine/
- Virtual commissioning (30–75% less on-site commissioning, vendor-reported):
  - https://www.visualcomponents.com/blog/increasing-control-software-quality-with-virtual-commissioning/
  - https://blogs.sw.siemens.com/tecnomatix/Virtual-Commissioning-A-practical-guide
- Palletizing ergonomics:
  - NIOSH: https://stacks.cdc.gov/view/cdc/228122/cdc_228122_DS1.pdf
  - Robotiq (secondary BLS figures): https://blog.robotiq.com/from-injury-to-innovation-why-manual-palletizing-is-ripe-for-automation
