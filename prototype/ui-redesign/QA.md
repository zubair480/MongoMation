# QA log (Agent F)

Format: id | page | steps | expected | actual | owner | status | screenshot note
Test env: user's Chrome, window 1920x799 CSS px, Intel Iris Xe (ANGLE D3D11), pixelRatio 1.

## Open

### QA-1 · room.html · render cost too high (perf) · owner A
- Steps: open room.html?v=102, run renderer.render(scene,camera)+gl.finish() x5 via window.__room3d.
- Expected: < ~16 ms per frame on the bird's-eye view.
- Actual: 70-190 ms per frame (101/77/70/78/90 ms on a second run). renderer.info: 1848 draw calls, 176k tris, 930 meshes, 943 geometries, 43 textures, shadowMap on with 1 shadow light (shadow pass doubles the calls).
- Fix hint: merge static props (cable trays with many rungs, racks, cabinets) with BufferGeometryUtils.mergeGeometries or InstancedMesh, share geometries/materials, and limit castShadow to big objects.
- Screenshot: n/a (numbers).

### QA-2 · room.html · Esc does not close the Open PLC overlay after clicking inside it · owner B
- Steps: hall -> Open CAB-01 -> Open PLC -> overlay opens -> press Esc.
- Expected: Esc closes the overlay (the button is labelled "Close Esc").
- Actual: nothing happens. document.activeElement is IFRAME#frame, so the keydown goes to the iframe and the parent never sees it. Clicking "Close Esc" works.
- Fix hint: in the iframe page, forward Escape via postMessage to the parent, or blur the iframe/focus the parent after load. (May be moot if Open PLC moves to dashboard.html as a full page.)

### QA-3 · room.html · off-palette colours: blue cable-tray stripes and green props · owner A
- Steps: hall bird's-eye view.
- Expected: design system = white, ink #0B0B0C, hairlines, orange #FF5A1F only for live/active; no blue/green themes.
- Actual: every cable tray has bright blue cable stripes (very visible across the whole hall, especially top-down); green wall sign (right wall) and a green object on the left wall/pillar inside the cabinet view (left edge when CAB-01 is focused). Red wall boxes and a red cart too.
- Screenshot note: bird's-eye; top-down drag shows the blue stripes dominating.

### QA-4 · room.html · orbit/zoom limits reveal the void around the room · owner A
- Steps: scroll-wheel down 10 ticks (zoom out), drag up/down.
- Expected: the camera stays inside a plausible hall; no empty white void, no floating box.
- Actual: zoomed out, the room is a small box floating on an infinite white plane (no hall around it). Dragging fully up gives a pure top-down view where cabinets read as black slabs; the CAB-01/CAB-02 labels float over the back wall area, not over their cabinets. (A's hall work should cover the void; please also clamp maxDistance and minPolarAngle a bit, e.g. >= 0.25 rad.)

### QA-5 · APIs :5190 + :5191 · dead job still reported as "running" · owner C (and E)
- Steps: GET :5190/api/health, :5190/api/projects, :5191/api/health (13:03).
- Expected: when the worker heartbeat is stale (> 15 s) the active job/project is flagged as stale/orphaned, so the UI never shows fake progress (API.md's own rule).
- Actual: worker laptop-worker last beat ~400-450 s ago (worker.online:false), but job 6acbe9dac9f28d84f6ffb5d3 and project 6acbe9dad1ddf164b497ee16 are still status "running"; :5191 activeJob.status "running" too. A UI that trusts status will spin forever.
- Fix hint: add e.g. `stale: true` / `workerAlive: false` on job/project/activeJob when claimedBy's heartbeat is older than 15 s (do not rewrite Atlas).

### QA-6 · :5190 /api/scenes · tag addresses are all null · owner C
- Expected (API.md): tags[].address like "%QX0.0".
- Actual: sorting-by-height-basic has 24 tags, 0 with an address (address:null, direction:null). Either fill from the scene's IO map or update API.md. B's IO strip needs addresses.

### QA-7 · :5191 · unknown ids return HTTP 200 with nulls · owner E (low)
- /api/project/bad -> 200 {project:null,...}; /api/plc/000..0 -> 200 {found:false}; /api/timeline/x/y -> 200 {found:false}. Prefer 404 (or at least validate the ObjectId format -> 400) so the UI can tell "missing" from "empty". Also API-READ.md is not published yet (13:05).

### QA-8 · dashboard.html · E-STOP button clipped + 3D tag labels overlap · owner B
- Steps: open dashboard.html?ex=sorting at 1920x799.
- Actual: (a) BUTTON.estop right edge = 1943 px > 1920 viewport, the red E-STOP disc is cut in half at the right edge of the Operator panel. (b) With Labels on, the 3D tag labels pile on top of each other (Conveyor entry / High sensor / Low sensor overlap; "At right ent..." hidden under "Loaded"; Conveyor left under At left exit). Unreadable in the default view and in Auto camera.
- Also: Inject-fault select truncates its text ("Left exit eye blocked (At left"), the hint line under the operator buttons is cut with an ellipsis.
- Fix hint: give the operator row min-width/wrap or shrink E-STOP; label de-collision (hide labels whose screen rects intersect, or only show labels on hover / for the 6 key tags).

### QA-9 · dashboard.html · Log tab shows Harness content · owner B
- Steps: finish mock run -> click Harness (shows Lessons learned/Traces/Durability) -> click Log.
- Expected: Log panel (events).
- Actual: Log tab gets class "tab on" but the panel still shows Harness "Lessons learned". Reproduced twice. Also tabs have role=tab but no aria-selected.

### QA-10 · dashboard.html · fault injection does not stop the line + stray red slab in 3D · owner B
- Steps: mock run to 7/7 verified -> Start -> select "Left exit eye blocked" -> Inject fault, wait 15 s.
- Expected (spec): left exit blocked > 3 s -> stop left conveyor, light Reset lamp as fault lamp; line stops until Reset.
- Actual: PLC card says "fault latched", but the stage caption still says "Verified · monitoring · line running · 33 boxes sorted", COUNT keeps rising (0028 -> 0031 -> 0033) and Conveyor left/right stay TRUE. A plain red rectangle (3D mesh, about 200x25 px, no text) appears at the bottom right of the 3D stage; it looks like a broken banner and is off-palette red.

## Fixed (re-tested)

## Notes / measurements
- 13:02 room.html: no console errors on load. Hall -> CAB-01 focus -> door open -> Open PLC overlay -> Close -> Esc back to hall all work.
- Open PLC still loads plc.html in an overlay iframe (expected to change to dashboard.html by B).
