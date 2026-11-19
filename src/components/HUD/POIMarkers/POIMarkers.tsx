"use client";

import { useRef, useEffect } from "react";
import { poiBuffer } from "@/store/poi";
import { formatDistance } from "@/sim/units";

import "./POIMarkers.scss";

/** Padding (px) from viewport edge for off-screen arrows. */
const EDGE_PADDING = 32;
/** HUD homes: edge arrows slide out of them and marker labels under them hide. */
const AVOID_SELECTOR =
  ".cargo-hud, .hud__panel-buttons, .objective-tracker, .transit-hud--side, .ship-dashboard, .hotbar, .notif-stack__item, .settings__open-button, .target-card--visible, .comms-overlay, .transit-hud--spooling";
const AVOID_REFRESH_MS = 100;
const MAX_LABELS = 128;
/** Half-size of the box around the reticle whose labels hide while the Target Card shows. */
const RETICLE_CLEAR_PX = 48;
/** A drawn object's label sits below its disc plus bloom (×1.2), capped so a point filling the view keeps it on screen. */
const objectLabelOffsetPx = (frac: number, h: number): number => (frac > 0 ? Math.min(160, Math.round(frac * h * 1.2) + 4) : 0);

/**
 * HUD overlay that renders POI markers and off-screen direction arrows.
 * Uses a rAF loop reading from the shared mutable `poiBuffer` —
 * no React re-renders in the hot path (same pattern as PingBrackets).
 */
export default function POIMarkers() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Pool of managed DOM elements, keyed by POI id.
    const markerEls = new Map<string, HTMLElement>();
    const arrowEls = new Map<string, HTMLElement>();
    // Flat [l, t, r, b] boxes: HUD homes (rects read every 100 ms, not per frame) and placed labels.
    const avoid: number[] = [];
    let avoidAt = -Infinity;
    const placed = new Float64Array(MAX_LABELS * 4);
    let placedN = 0;
    const hitsAvoid = (l: number, t: number, r: number, b: number): number => {
      for (let k = 0; k < avoid.length; k += 4) if (l < avoid[k + 2] && avoid[k] < r && t < avoid[k + 3] && avoid[k + 1] < b) return k;
      return -1;
    };
    const hitsPlaced = (l: number, t: number, r: number, b: number): boolean => {
      for (let k = 0; k < placedN * 4; k += 4) if (l < placed[k + 2] && placed[k] < r && t < placed[k + 3] && placed[k + 1] < b) return true;
      return false;
    };
    /** One pass over in-view labels (rank 0 targeted, 1 focused, 2 rest): first placed keeps its label. */
    const declutter = (rank: number): void => {
      const pois = poiBuffer.pois;
      const w = window.innerWidth;
      const h = window.innerHeight;
      for (let i = 0; i < pois.length; i++) {
        const poi = pois[i];
        const marker = markerEls.get(poi.id);
        if (!poi.inView || !marker) continue;
        const r0 = poiBuffer.targetedId === poi.id ? 0 : poi.focused ? 1 : 2;
        if (r0 !== rank) continue;
        const label = marker.lastElementChild as HTMLElement | null;
        if (!label) continue;
        const name = label.firstElementChild as HTMLElement;
        const dist = label.lastElementChild as HTMLElement;
        const named = name.style.display !== "none";
        // Estimated box (10 px caps ≈ 7 px per glyph, + 4 px margin): no layout reads per frame.
        const chars = Math.max(named ? (name.textContent ?? "").length : 0, (dist.textContent ?? "").length);
        const x = poi.sx * w;
        const y = poi.sy * h;
        const half = chars * 3.5 + 4;
        const off = objectLabelOffsetPx(poi.objectRadiusFrac, h);
        const l = x - half, r = x + half, t = y + 10 + off, b = y + 12 + off + (named ? 26 : 13);
        const show = !hitsPlaced(l, t, r, b) && hitsAvoid(l, t, r, b) === -1;
        if (show && placedN < MAX_LABELS) {
          const o = placedN++ * 4;
          placed[o] = l;
          placed[o + 1] = t;
          placed[o + 2] = r;
          placed[o + 3] = b;
        }
        const vis = show ? "" : "hidden";
        if (label.style.visibility !== vis) label.style.visibility = vis;
      }
    };

    // Called by POIProjector at the end of its useFrame — same frame as
    // the 3D projection, so markers are perfectly in sync with the scene.
    const flush = () => {
      const pois = poiBuffer.pois;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const now = performance.now();
      if (now - avoidAt >= AVOID_REFRESH_MS) {
        avoidAt = now;
        avoid.length = 0;
        document.querySelectorAll<HTMLElement>(AVOID_SELECTOR).forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) avoid.push(r.left, r.top, r.right, r.bottom);
        });
        // The Target Card names its target: a marker label under the reticle would repeat it (R3)
        // and sits on the object's own glow (placed points, wrecks).
        if (document.querySelector(".target-card--visible")) {
          const c = document.querySelector(".reticle__circle")?.getBoundingClientRect();
          if (c) {
            const x = c.left + c.width / 2, y = c.top + c.height / 2;
            avoid.push(x - RETICLE_CLEAR_PX, y - RETICLE_CLEAR_PX, x + RETICLE_CLEAR_PX, y + RETICLE_CLEAR_PX);
          }
        }
      }

      const activeIds = new Set<string>();
      for (let i = 0; i < pois.length; i++) activeIds.add(pois[i].id);

      // Remove stale elements.
      markerEls.forEach((child, id) => {
        if (!activeIds.has(id)) {
          child.remove();
          markerEls.delete(id);
        }
      });
      arrowEls.forEach((child, id) => {
        if (!activeIds.has(id)) {
          child.remove();
          arrowEls.delete(id);
        }
      });

      for (let i = 0; i < pois.length; i++) {
        const poi = pois[i];

        // ── In-view marker ───────────────────────────────────────
        if (poi.inView) {
          // Hide arrow if it exists.
          const arrow = arrowEls.get(poi.id);
          if (arrow) arrow.style.opacity = "0";

          let marker = markerEls.get(poi.id);
          if (!marker) {
            marker = createMarkerElement(poi.id, poi.kind);
            el.appendChild(marker);
            markerEls.set(poi.id, marker);
            // Fade in next frame.
            const m = marker;
            requestAnimationFrame(() => { m.style.opacity = "1"; });
            continue;
          }

          marker.style.opacity = "1";
          marker.style.left = `${poi.sx * 100}%`;
          marker.style.top = `${poi.sy * 100}%`;

          const isTargeted = poiBuffer.targetedId === poi.id;

          const label = marker.lastElementChild as HTMLElement;
          const shift = objectLabelOffsetPx(poi.objectRadiusFrac, h);
          const tf = shift ? `translateY(${shift}px)` : "";
          if (label.style.transform !== tf) label.style.transform = tf;

          // Distance label (the ETA lives in the transit panel only, R3).
          const distEl = marker.querySelector(".poi-marker__distance") as HTMLElement;
          if (distEl) {
            const text = formatDistance(poi.distanceKm);
            if (distEl.textContent !== text) distEl.textContent = text;
          }

          // Name label — show when focused OR targeted; a pilot's always (who is that?).
          const nameEl = marker.querySelector(".poi-marker__name") as HTMLElement;
          if (nameEl) {
            nameEl.style.display = (poi.focused || isTargeted || poi.kind === "pilot") ? "" : "none";
            if (nameEl.textContent !== poi.name) nameEl.textContent = poi.name;
          }

          // Diamond highlight when targeted.
          const diamond = marker.querySelector(".poi-marker__diamond") as HTMLElement;
          if (diamond) {
            diamond.classList.toggle("poi-marker__diamond--targeted", isTargeted);
          }
        } else {
          // ── Off-screen arrow ─────────────────────────────────────
          // Hide marker if it exists.
          const marker = markerEls.get(poi.id);
          if (marker) marker.style.opacity = "0";

          let arrow = arrowEls.get(poi.id);
          if (!arrow) {
            arrow = createArrowElement(poi.id, poi.kind);
            el.appendChild(arrow);
            arrowEls.set(poi.id, arrow);
            const a = arrow;
            requestAnimationFrame(() => { a.style.opacity = "1"; });
            continue;
          }

          arrow.style.opacity = "1";

          // Position arrow at viewport edge in the direction of the POI.
          const angle = poi.edgeAngle;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);

          // Intersect ray from center with viewport rect (with padding).
          const cx = w / 2;
          const cy = h / 2;
          const hw = cx - EDGE_PADDING;
          const hh = cy - EDGE_PADDING;

          // Scale factor to reach the viewport edge.
          let scale = Infinity;
          if (cos !== 0) scale = Math.min(scale, Math.abs(hw / cos));
          if (sin !== 0) scale = Math.min(scale, Math.abs(hh / sin));

          const ax = cx + cos * scale;
          let ay = cy + sin * scale;
          // Slide along the edge out of any HUD home it lands in (twice: one push can land in another).
          for (let pass = 0; pass < 2; pass++) {
            const k = hitsAvoid(ax - 8, ay - 8, ax + 8, ay + 8);
            if (k === -1) break;
            const onTop = ay <= EDGE_PADDING + 0.5;
            const onBottom = ay >= h - EDGE_PADDING - 0.5;
            const below = onTop || (!onBottom && (avoid[k + 1] + avoid[k + 3]) / 2 < cy);
            ay = below ? avoid[k + 3] + 10 : avoid[k + 1] - 10;
          }

          arrow.style.left = `${ax}px`;
          arrow.style.top = `${ay}px`;
          // Rotate so the triangle points toward the POI.
          arrow.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
        }
      }
    };

    const flushAll = (): void => {
      flush();
      placedN = 0;
      declutter(0);
      declutter(1);
      declutter(2);
    };

    poiBuffer.flush = flushAll;
    return () => {
      poiBuffer.flush = null;
      el.innerHTML = "";
      markerEls.clear();
      arrowEls.clear();
    };
  }, []);

  return <div ref={containerRef} className="poi-markers" />;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function createMarkerElement(id: string, kind?: "pilot"): HTMLDivElement {
  const el = document.createElement("div");
  el.className = kind ? `poi-marker poi-marker--${kind}` : "poi-marker";
  el.dataset.id = id;
  el.style.opacity = "0";

  const diamond = document.createElement("div");
  diamond.className = "poi-marker__diamond";
  el.appendChild(diamond);

  const label = document.createElement("div");
  label.className = "poi-marker__label";

  const name = document.createElement("div");
  name.className = "poi-marker__name";
  name.style.display = "none";
  label.appendChild(name);

  const dist = document.createElement("div");
  dist.className = "poi-marker__distance";
  label.appendChild(dist);

  el.appendChild(label);
  return el;
}

function createArrowElement(id: string, kind?: "pilot"): HTMLDivElement {
  const el = document.createElement("div");
  el.className = kind ? `poi-arrow poi-arrow--${kind}` : "poi-arrow";
  el.dataset.id = id;
  el.style.opacity = "0";
  return el;
}

