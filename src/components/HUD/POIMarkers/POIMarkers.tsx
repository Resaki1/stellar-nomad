"use client";

import { useRef, useEffect } from "react";
import { poiBuffer } from "@/store/poi";
import { formatDistance } from "@/sim/units";

import "./POIMarkers.scss";

/** Padding (px) from viewport edge for off-screen arrows. */
const EDGE_PADDING = 32;

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

    // Called by POIProjector at the end of its useFrame — same frame as
    // the 3D projection, so markers are perfectly in sync with the scene.
    const flush = () => {
      const pois = poiBuffer.pois;
      const w = window.innerWidth;
      const h = window.innerHeight;

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
            marker = createMarkerElement(poi.id);
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

          // Distance label (+ ETA if targeted).
          const distEl = marker.querySelector(".poi-marker__distance") as HTMLElement;
          if (distEl) {
            let text = formatDistance(poi.distanceKm);
            if (isTargeted && poiBuffer.targetedEtaS != null) {
              text += ` · ~${Math.ceil(poiBuffer.targetedEtaS)}s transit`;
            }
            distEl.textContent = text;
          }

          // Name label — show when focused OR targeted.
          const nameEl = marker.querySelector(".poi-marker__name") as HTMLElement;
          if (nameEl) {
            nameEl.style.display = (poi.focused || isTargeted) ? "" : "none";
            nameEl.textContent = poi.name;
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
            arrow = createArrowElement(poi.id);
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
          const ay = cy + sin * scale;

          arrow.style.left = `${ax}px`;
          arrow.style.top = `${ay}px`;
          // Rotate so the triangle points toward the POI.
          arrow.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
        }
      }
    };

    poiBuffer.flush = flush;
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

function createMarkerElement(id: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "poi-marker";
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

function createArrowElement(id: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "poi-arrow";
  el.dataset.id = id;
  el.style.opacity = "0";
  return el;
}

