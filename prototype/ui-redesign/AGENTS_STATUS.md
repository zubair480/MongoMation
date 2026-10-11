# Agent board: heartbeat every ~60s (append a line, newest at bottom)

## Ownership (do NOT edit files you don't own)
| Agent | Owns | Goal |
|---|---|---|
| A · room | plcroom.js, plcprops.js | Fill the empty white background with a plant hall + a live production line outside the control room |
| B · dashboard | dashboard.html (new), factory3d.js, plc.html, room.html | Open PLC → full-screen dashboard: persistent live 3D machine + live IO values + prompt + workflow; replace the dummy HMI/DCV SVGs with factory3d |
| C · real app | server/ (new, in prototype/ui-redesign/server), API.md | Real execution backend: a local API that runs the real pipeline (from the WSL repo /home/zubair/mongomation) and that dashboard.html can call in "Live" mode |

| D · PLC component | plcmacro.js (new), plcmacro-demo.html (new) | High-fidelity 3D PLC rack component (CPU + IO modules, live per-channel LEDs, click module → channel view), for the dashboard's "component" panel |
| E · live data | server-read/ (new), API-READ.md (new) | Read-only live data service from MongoDB Atlas: projects, runs, harness versions, lessons, traces, IO, on :5191 |
| F · QA | (no source files) QA.md (new) | Continuously test every page in Chrome, file bugs in QA.md and ping owners via the board |

## Contracts
- B reads C's API from API.md; until C publishes it, B uses the existing mock run (plc.html logic) behind a `mode: 'mock' | 'live'` switch.
- Server for the static UI: http://localhost:5178/ (python http.server, serves this folder). C runs its API on http://localhost:5190/ with CORS for localhost:5178.

## Heartbeats
- 12:59 B: started; reading plc.html/factory3d.js/room.html, planning dashboard.html
- 12:59 C: started; investigating WSL repo worker/job schema
- 13:00 D: started; planning plcmacro.js (3D PLC rack component) + plcmacro-demo.html
- 13:00 E: started; reading WSL queries.ts + env var names for Atlas
- 13:00 F: started; QA.md created, opening own Chrome tab, testing room.html first
- 13:01 B: plan = dashboard.html (3D left / workflow right / IO+operator strip bottom) + factory3d opts (offset, labels, quality, forced). Will reserve a 'Component' stage toggle for D's plcmacro.js and wire E's API-READ in live mode
- 13:00 C: API.md v0.1 draft published (prototype/ui-redesign/API.md); building server/ next
- 13:01 A: read board + plcroom/plcprops; starting hall shell (buildHall in plcprops.js)
- 13:01 C: server/server.mjs written (WSL node, reuses repo driver+.env); starting on :5190, curling endpoints
- 13:06 B: factory3d.js extended (offset/quality/labels/forced/setPaused/ResizeObserver, rAF fully stops when hidden); writing dashboard.html shell
- 13:02 E: server-read/server.mjs written (mirrors queries.ts); starting on :5191
- 13:03 F → A: QA-1 room render 70-190ms/frame, 1848 draw calls (merge/instance props); QA-3 blue tray stripes + green props off-palette; QA-4 zoom-out shows floating box, clamp orbit
- 13:03 F → B: QA-2 Esc does not close Open PLC overlay when iframe has focus
- 13:03 C: bridge LIVE on :5190 (health/scenes/projects/io/run/:id verified vs real Atlas). Worker OFFLINE since 19:56Z; asked main whether to start it. B: API.md v0.2 coming in ~2 min
- 13:03 E: :5191 LIVE against Atlas (health/projects/project/plc/timeline/harness/ablation/scenes/SSE change stream); writing API-READ.md
- 13:04 C: API.md v0.2 published with REAL example payloads (B: wire against it; poll /api/health for worker/rig badges). Waiting on main re: starting worker for smoke job
- 13:05 F → C: QA-5 job/project still 'running' though worker heartbeat ~7 min stale (flag stale); QA-6 /api/scenes tag addresses all null vs API.md
- 13:05 F → E: QA-5 same stale 'running' activeJob on :5191; QA-7 unknown ids return 200+nulls (low); API-READ.md missing
- 13:05 D: writing plcmacro.js (atlas faceplates, instanced LEDs/terminals, merged ducts/wires)
- 13:05 E: API-READ.md PUBLISHED (B: read it; base http://localhost:5191, live IO = /api/health rig.tags, SSE /api/events/stream). Start: cd server-read && npm start
- 13:05 E: DONE. :5191 live on real Atlas, verified via curl + Chrome tab (/api/health). Worker heartbeat ~9 min stale (worker offline), so SSE will be quiet until the worker writes. Restart: cd server-read && npm start
- 13:05 C: DONE (handing back). Bridge :5190 + API.md v0.2 ready. Smoke job NOT run: worker offline, starting it would resume stale job 6acbe9da...; awaiting main/user decision
- 13:06 F: dashboard.html appeared, testing it now; plcmacro-demo.html not yet
- 13:05 B: dashboard.html v1 assembled (Ali's orchestration copied + 3D stage + IO strip + operator + mock/live runAdapter wired to API.md). Opening in Chrome for milestone 1
- 13:07 B: M1 verified in Chrome (layout + live 3D + IO strip, no console errors); full mock run reaches Verified with line running in 3D. Now checking mid-run camera sync + fault injection
- 13:08 A: hall shell + line code written (plcprops.buildHall), wiring done; loading in Chrome
- 13:09 F: dashboard.html mock run passes end to end (Generate -> 7/7 verified, no console errors); filing layout bugs for B next
- 13:08 D: plcmacro.js + plcmacro-demo.html drafted; verifying in Chrome
- 13:08 B: live mode wired (lamps <- :5191 health, IO <- :5190/api/io stale-aware, Harness+Lessons <- :5191/api/harness, run <- POST :5190/api/run behind cost confirm, read-only 'View latest real job'). Testing in Chrome
- 13:09 A: milestone1 loads w/o errors; perf heavy (~1970 draw calls, mostly the 10 cabinets @85 meshes each). Merging cabinet carcass/door/PLC meshes now
- 13:11 F → B: dashboard QA-8 E-STOP clipped off right edge + 3D labels overlap; QA-9 Log tab shows Harness content; QA-10 injected fault latches but line keeps running/counting + stray red slab in 3D
