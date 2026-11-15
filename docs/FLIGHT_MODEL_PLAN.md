# Flight Model v2 — plan (Roadmap M1)

**Status:** built 2026-11-15; all gates in §7 pass headless; awaiting the playtest. Every number below is a
starting value: all of them live in one tuning table that can be changed live from
Settings → Dev, because feel can only be finished by flying it.

## 1. What players of other games expect

| | Steering | Forward/back | A/D | Roll | Boost |
|---|---|---|---|---|---|
| Star Citizen | mouse = virtual stick | W/S thrust, speed limiter on wheel | strafe | Q/E | Shift |
| Elite Dangerous | mouse = virtual stick (optional auto-centre) | W/S throttle set-point | yaw/strafe | Q/E | Tab |
| No Man's Sky | mouse = virtual stick | W accelerate, S brake | roll | A/D | Shift |
| Battlefront II | mouse = virtual stick | W/S speed band | roll | A/D | Shift |
| Everspace 2 | mouse aim | W/S thrust | strafe | Q/E | Shift |
| War Thunder | mouse aim (craft chases a marker) | W/S throttle set-point | roll/yaw | Q/E | — |

Written from memory of these games' default bindings, not re-checked against current
versions; the pattern matters more than any single key. Free look exists in the sims
(Star Citizen: hold Z; Elite: head look) and Alt is the DayZ/ARMA convention for it.

Common ground, which is what we ship: **mouse steers pitch and yaw, Q/E roll, Shift boosts,
a held key gives free look.** The two real choices are what A/D do (strafe wins in every
6DOF game; roll only in the arcade ones) and what W/S do.

## 2. Controls (defaults, all rebindable)

| Input | Action |
|---|---|
| Mouse | pitch / yaw (mode A or B below) |
| W / S | throttle set-point up / down (hold to ramp; it stays where you leave it) |
| Mouse wheel | throttle fine adjust (as today) |
| A / D | strafe left / right |
| Space / Left Ctrl | strafe up / down |
| Q / E | roll left / right |
| Left Shift (hold) | boost |
| X | brake: throttle to zero and full stop |
| V | toggle flight assist: coupled ↔ decoupled |
| Left Alt (hold) | free look |
| Arrow keys | pitch / yaw (keyboard fallback, no mouse needed) |
| M, P, T, Tab/I, R, F, L, Esc | unchanged (mine, pulse, transit, panels, settings) |

Persistent throttle (not hold-W-to-fly) because this is a game of long straight flights.
`accelerate`/`decelerate` lose their old Shift/E and Ctrl/C defaults; saved custom keybinds
that collide with a new default are reset for the colliding action only.

**Mouse modes** (Settings → Controls):

- **A. Virtual stick (default).** Mouse motion moves a stick marker inside a circle around
  the nose reticle; its offset is the turn-rate command. Deadzone 4% of the radius, response
  curve exponent 1.5, optional auto-centre (off by default). Leave the marker off-centre
  and the ship keeps turning. This is the Star Citizen / Elite / Battlefront scheme.
- **B. Aim.** Mouse motion moves an aim marker that is a fixed direction in space, limited
  to a 25° cone around the nose; the ship turns to put its nose on it and stops there.
  FPS-like: stop moving the mouse and the turn ends.

Both produce the same `ShipInput`; the sim does not know which is active.

**Pointer lock.** Taken on the click/key that enters play and on any click on the canvas,
with `unadjustedMovement` where supported. Opening a panel or the settings menu releases
it and centres the stick. Losing it by Esc opens the settings (pause) menu.

**Free look.** While held: mouse moves the camera around the ship (yaw unlimited, pitch ±89°),
the stick is centred and ignores the mouse, so the ship holds its heading. On release the
camera eases back in 0.25 s. `Alt` gets `preventDefault` so the browser menu does not
steal focus.

Touch keeps the existing joystick (pitch/yaw) and throttle drag. Gamepad is out of scope;
it becomes one more mapper onto `ShipInput`.

## 3. Physics

State added to `ShipState`: linear velocity (km/s, relative to the current reference
frame), angular velocity (rad/s, body axes), boost charge, assist mode. The scalar `speed`
and the cosmetic `vRoll`/`vPitch` tilt are removed.

Integration per fixed 120 Hz step, semi-implicit Euler: accelerations → velocity →
position; angular acceleration → angular velocity → orientation. `stepShip` stays pure.

**Rotation** (both assist modes): rate command. Commanded rate = input × max rate; the
angular velocity moves toward it at a limited angular acceleration. No input = rate
command zero, so rotation always stops by itself.

**Translation, coupled (default).** A velocity set-point in body axes:
forward = throttle × speed limit, lateral/vertical = strafe × strafe limit. The velocity
error, expressed in body axes, is removed with per-axis acceleration limits: main engine
for +forward, retro for −forward, and for the sideways components the larger of the strafe
thrusters and the **grip** limit. Turning therefore drags the velocity vector round to the
nose; how fast is what makes a ship feel tight or slidy.

**Translation, decoupled.** No set-point and no automatic braking. W/S, A/D, Space/Ctrl
are direct thrust while held. Rotation does not change the velocity vector. The speed
limit still applies (thrust that would exceed it is cut), X still brakes.

**Speed limit.** The flight computer's limit is the speed from which the ship can stop
within its sensor range: `v_limit = sqrt(2 · a_retro · d_stop)`, so better retro thrust
and better scanners both raise it. Module effects map onto the terms
(`maxSpeedMultiplier` scales the result, `accelerationMultiplier` scales main and strafe
thrust, `decelerationMultiplier` scales retro and grip).

**Boost** (hold): a sprint. Full boosted main thrust up to the boosted limit, whatever the
throttle set-point is (also from a standstill); on release the ship returns to the
set-point speed. Lasts while charge lasts;
charge drains while held and refills after a short delay. It is a self-contained
capacitor now and becomes a draw on power and heat in M3.

**Brake** (X): throttle set-point to zero and all thrusters, including grip, against the
velocity vector until at rest relative to the frame.

**Frames.** Velocity is relative to the ship's current frame, so "at rest" means at rest
relative to the body it is near. On a frame switch the velocity is carried over unchanged
(reinterpreted in the new frame); converting it would hand the assist up to ~1 km/s to
cancel at a boundary nobody can see. The transit drive stays an additive velocity as today.

### Starting values (tier-0 ship)

| Quantity | Value | Note |
|---|---|---|
| Main thrust | 120 m/s² | 0 → 400 m/s in ~3.3 s |
| Retro thrust | 90 m/s² | |
| Strafe thrust (lateral, vertical) | 60 m/s² | |
| Strafe speed limit | 80 m/s | coupled set-point only |
| Grip | 250 m/s² | no slide below ~260 m/s at full yaw rate, slide above |
| Stop distance `d_stop` | 0.9 km | gives `v_limit` ≈ 400 m/s, today's top speed |
| Max rates pitch / yaw / roll | 70 / 55 / 120 °/s | today: 43 °/s |
| Angular acceleration | 250 °/s² | ~0.3 s to full rate |
| Boost | thrust ×2, limit ×1.5, 5 s charge, 8 s refill after 1.5 s | |
| Throttle ramp | 0 → 1 in 2 s held | as today |
| Velocity-error time constant | 0.25 s | keeps the assist from chattering near the set-point |

## 4. Camera

One rig interface (`update(camera, shipPose, shipMotion, dt)`), chase rig now, cockpit rig
later.

- **Orientation lag.** The camera follows the ship's orientation with a critically damped
  spring (time constant 0.10 s). The ship visibly leads the turn; this replaces the fake
  model tilt.
- **Bank.** Visual only: the ship model rolls into yaw (up to 25°) and leans into pitch (up
  to 6°) in proportion to turn rate. The ship's real orientation is unaffected; real roll
  stays on Q/E. Added after the first playtest, which missed the arcade-game bank.
- **Motion offset.** The camera gives way against acceleration (back under thrust and
  boost, sideways under strafe), bounded, spring-damped.
- **FOV.** Widens with speed fraction and boost (up to +8°).
- **Free look** as in §2. Shake as today, applied last.
- Because of the lag the screen centre is no longer the nose. The **nose reticle is drawn
  at the projected forward direction** each frame (DOM transform through a ref, no React
  state), and mining and POI targeting keep using the ship's forward vector.

## 5. HUD additions (existing HUD style)

Nose reticle (moves), stick marker or aim marker, velocity-vector marker when drifting
more than 2 m/s off the nose, throttle set-point next to actual speed, assist mode
(COUPLED / DECOUPLED), boost charge.

## 6. Code shape

- `src/sim/ship/flightTuning.ts` — the one table of constants above, plus a mutable live
  copy the dev panel edits. `src/sim/ship/flightAssist.ts` — set-point → accelerations.
  `src/sim/ship/aimController.ts` — mode B (target direction → pitch/yaw command).
- `src/input/` — devices → `playerInput` (plain buffer). `sampleShipInput(out, …)` is
  called once per frame by the ship orchestrator. `movementAtom` goes away; the HUD reads
  throttle at human rate.
- `ShipInput`: `pitch, yaw, roll, strafeX, strafeY` in −1..1, `throttle` 0..1, `boost`,
  `brake`, `decoupled`.
- **Deterministic harness:** `__test.flight.simulate(script)` runs a fresh `ShipState`
  through `stepShip` with a scripted input sequence, in-page, with no rendering. Gates use
  it, so results do not depend on frame rate or key timing.

## 7. Exit gates

Pure-sim gates through `__test.flight.simulate` (exact, repeatable):

1. Full throttle from rest reaches 99% of `v_limit` within `v_limit / a_main + 1 s`.
2. Brake from `v_limit` stops within `v_limit² / (2·a_retro)` + 10% distance.
3. Full yaw input reaches max rate within 0.4 s; released, rotation ends within 0.5 s.
4. Coupled, 90° yaw at half speed: sideslip under 2° within 1.5 s of the turn ending.
   At full speed the same turn slides (peak sideslip over 10°) and still recovers.
5. Decoupled, coasting, 90° yaw: velocity direction and magnitude unchanged to 1e-9.
6. Strafe reaches its limit; released in coupled mode, lateral speed returns to zero.
7. Boost: higher acceleration and limit while charge lasts; drains and refills on schedule.
8. Determinism: the same script twice gives bit-identical final state.

Live gates in headless Chrome:

9. Free look: with it held, injected mouse motion moves the camera and leaves the ship
   quaternion unchanged; released, the camera is back within 0.5 s.
10. Stick and aim modes turn the ship the expected way and amount for an injected motion.
11. Reference frames, saves and the title/loading shell still pass their M0 gate scripts.
12. Screenshots of the HUD additions looked at, at 1280×720 and 390×844.

Then a playtest by Christian with the dev tuning panel; values that survive it become the
defaults.

## 8. Out of scope

Collision response (M2), fuel/power/heat (M3), gamepad, cockpit camera, atmospheric drag
and entry heating (M7), changes to the transit drive.
