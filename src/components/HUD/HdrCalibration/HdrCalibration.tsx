"use client";

import { useAtom } from "jotai";
import { useCallback, useEffect } from "react";

import {
  CAL_MAX_STOPS,
  CAL_STEP_STOPS,
  setCalibrationStops,
} from "@/components/space/hdrCalibration";
import { hdrCalibrationOpenAtom, settingsAtom } from "@/store/store";

import "./HdrCalibration.scss";

/**
 * Phase 6d — the HDR calibration screen's controls.
 *
 * The *pattern* is not here: it is a node that replaces `pipeline.outputNode`
 * (`space/hdrCalibration.ts`), because 🔑 **HTML cannot exceed reference white** — a CSS
 * colour tops out at `#fff` = 1.0, so a DOM patch can never test headroom and would look
 * like it was working while measuring nothing. This component is only the slider, the
 * instruction and the readout, drawn over the canvas the wedge is rendered into.
 *
 * ⚠ Which is also why this panel sits at the BOTTOM: the wedge occupies the middle of the
 * screen and a centred modal would cover the thing being measured.
 */
const HdrCalibration = () => {
  const [open, setOpen] = useAtom(hdrCalibrationOpenAtom);
  const [settings, setSettings] = useAtom(settingsAtom);

  const stops = settings.hdrPeakStops ?? 2;

  // The field's brightness is a uniform, so dragging updates the pattern with no shader
  // recompile — which is what makes a change-detection procedure usable at all.
  useEffect(() => {
    if (open) setCalibrationStops(stops);
  }, [open, stops]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  // Esc closes, matching every other modal in the HUD.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const linear = Math.pow(2, stops);

  return (
    <div className="hdr-cal">
      <div className="hdr-cal__panel">
        <div className="hdr-cal__title">HDR calibration</div>

        <ol className="hdr-cal__steps">
          <li>
            Inside the bright block above, between the four corner marks, is a
            patch <strong>{CAL_STEP_STOPS} of a stop brighter</strong> than its
            surround.
          </li>
          <li>
            Start low and drag the slider up slowly. At some point the patch{" "}
            <strong>disappears</strong> — your display cannot go any brighter,
            so it and the block are now the same.
          </li>
          <li>
            Leave the slider at the <strong>lowest</strong> point where it has
            just vanished.
          </li>
        </ol>

        <label className="hdr-cal__label">
          headroom {stops.toFixed(2)} stops ({linear.toFixed(1)}× white)
          <input
            className="hdr-cal__range"
            type="range"
            min={0}
            max={CAL_MAX_STOPS}
            step={CAL_STEP_STOPS}
            value={stops}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                hdrPeakStops: Number(e.target.value),
              }))
            }
          />
        </label>

        <div className="hdr-cal__note">
          ⚠ Headroom depends on your screen brightness — it{" "}
          <strong>shrinks as you turn the screen up</strong>. If you change it,
          calibrate again.
        </div>

        <div className="hdr-cal__note hdr-cal__note--dim">
          The narrow strip above the block steps 0–11 in 8-bit code values. It records nothing — it
          shows how far into the dark this panel resolves, which is what limits
          the night side of a planet. For reference, the tone curve&rsquo;s own
          black floor is finer than one code value, so anything you cannot see
          here is the display&rsquo;s limit and not ours.
        </div>

        <div className="hdr-cal__actions">
          <button className="hdr-cal__button" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default HdrCalibration;
