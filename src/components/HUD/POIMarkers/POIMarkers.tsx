"use client";

import { useRef, useEffect } from "react";
import { useAtomValue } from "jotai";
import { MARKER_CATEGORIES } from "@/data/markerCategories";
import { markerPrefsAtom, markerRevealAtom } from "@/store/markerPrefs";
import { poiBuffer, type ProjectedPOI } from "@/store/poi";
import { formatDistance } from "@/sim/units";

import "./POIMarkers.scss";

/** Padding (px) from viewport edge for off-screen arrows. */
const EDGE_PADDING = 36;
/** HUD homes: marker glyphs and labels under them hide, edge arrows slide out of them. */
const AVOID_SELECTOR =
  ".cargo-hud, .hud__panel-buttons, .hud__session-menu, .placement-card, .objective-tracker, .transit-hud--side, .ship-dashboard, .hotbar, .notif-stack__item, .target-card--visible, .comms-overlay, .transit-hud--spooling";
const AVOID_REFRESH_MS = 100;
const MAX_LABELS = 128;
/** Half-size of the box around the reticle whose labels hide while the Target Card shows. */
const RETICLE_CLEAR_PX = 48;
/** Markers closer than this on screen merge into the most important one ("+N"). */
const CLUSTER_PX = 18;
const EDGE_MERGE_PX = 26;
/** A drawn object at least this big on screen gets corner brackets instead of a glyph. */
const BRACKET_MIN_PX = 12;
/** A label hides after this long in conflict and returns after this long clear (no flicker). */
const LABEL_HIDE_MS = 250;
const LABEL_SHOW_MS = 120;
const BRACKETABLE = new Set(["body", "depot", "point", "wreck", "drone"]);

type MarkerEls = {
  el: HTMLDivElement; glyph: HTMLDivElement; initial: HTMLSpanElement; pointer: HTMLDivElement; label: HTMLDivElement;
  name: HTMLDivElement; dist: HTMLDivElement; extra: HTMLSpanElement;
  /** Last written values: every DOM write is diffed. */
  cls: string; tf: string; labelTf: string; nameText: string; distText: string; extraText: string;
  nameShown: boolean; labelVisible: boolean; conflictSince: number; clearSince: number; bracketR: string; tint: string; initialText: string;
};

const rank = (p: ProjectedPOI): number =>
  p.id === poiBuffer.targetedId ? -3 : p.focused ? -2 : p.tracked ? -1 : MARKER_CATEGORIES[p.category].priority;

/**
 * HUD overlay for navigation markers (docs/MARKER_SYSTEM_PLAN.md §2): one element per marker that
 * is a glyph on screen, corner brackets round a resolved object, or an edge arrow off screen.
 * POIProjector calls `flush` right after projecting, in the same frame; no React renders.
 */
export default function POIMarkers() {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefs = useAtomValue(markerPrefsAtom);
  const reveal = useAtomValue(markerRevealAtom);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const hudRoot = el.closest(".hud");

    const markers = new Map<string, MarkerEls>();
    // Flat [l, t, r, b] boxes: HUD homes (sampled between frames, so no forced layout) and placed labels.
    const avoid: number[] = [];
    const sampleAvoid = (): void => {
      avoid.length = 0;
      document.querySelectorAll<HTMLElement>(AVOID_SELECTOR).forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) avoid.push(r.left, r.top, r.right, r.bottom);
      });
      // The Target Card names its target: a label under the reticle would repeat it (R3).
      if (document.querySelector(".target-card--visible")) {
        const c = document.querySelector(".reticle__circle")?.getBoundingClientRect();
        if (c) {
          const x = c.left + c.width / 2, y = c.top + c.height / 2;
          avoid.push(x - RETICLE_CLEAR_PX, y - RETICLE_CLEAR_PX, x + RETICLE_CLEAR_PX, y + RETICLE_CLEAR_PX);
        }
      }
    };
    sampleAvoid();
    const avoidTimer = window.setInterval(sampleAvoid, AVOID_REFRESH_MS);

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

    // Per-frame scratch (reused).
    const order: ProjectedPOI[] = [];
    const leaders: { x: number; y: number; m: MarkerEls; n: number; edge: boolean; badge: number }[] = [];
    const seen = new Set<string>();

    const flush = (): void => {
      if (hudRoot?.classList.contains("hud--hidden")) return;
      const pois = poiBuffer.pois;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const now = performance.now();
      const scale = Number(el.dataset.scale) || 1;
      const clusterOff = el.dataset.reveal === "1";

      seen.clear();
      for (let i = 0; i < pois.length; i++) seen.add(pois[i].id);
      markers.forEach((m, id) => {
        if (!seen.has(id)) {
          m.el.remove();
          markers.delete(id);
        }
      });

      // Most important first: the destination, the focused marker, tracked, then category priority.
      order.length = 0;
      for (let i = 0; i < pois.length; i++) order.push(pois[i]);
      order.sort((a, b) => rank(a) - rank(b));
      leaders.length = 0;
      placedN = 0;

      for (let i = 0; i < order.length; i++) {
        const poi = order[i];
        let m = markers.get(poi.id);
        if (!m) {
          m = createMarker(poi.id);
          el.appendChild(m.el);
          markers.set(poi.id, m);
        }
        const targeted = poiBuffer.targetedId === poi.id;
        let mode: "glyph" | "bracket" | "edge" | "hidden" = poi.inView ? "glyph" : poi.edge ? "edge" : "hidden";
        let x = poi.sx * w, y = poi.sy * h;
        const radiusPx = poi.objectRadiusFrac * h;
        if (mode === "glyph" && BRACKETABLE.has(poi.category) && radiusPx >= BRACKET_MIN_PX) mode = "bracket";

        if (mode === "edge") {
          const cos = Math.cos(poi.edgeAngle), sin = Math.sin(poi.edgeAngle);
          const hw = w / 2 - EDGE_PADDING, hh = h / 2 - EDGE_PADDING;
          let k = Infinity;
          if (Math.abs(cos) > 1e-6) k = Math.min(k, hw / Math.abs(cos));
          if (Math.abs(sin) > 1e-6) k = Math.min(k, hh / Math.abs(sin));
          x = w / 2 + cos * k;
          y = h / 2 + sin * k;
          // Slide along the edge out of any HUD home it lands in (twice: one push can land in another).
          for (let pass = 0; pass < 2; pass++) {
            const hit = hitsAvoid(x - 10, y - 10, x + 10, y + 10);
            if (hit === -1) break;
            const onTop = y <= EDGE_PADDING + 0.5, onBottom = y >= h - EDGE_PADDING - 0.5;
            const below = onTop || (!onBottom && (avoid[hit + 1] + avoid[hit + 3]) / 2 < h / 2);
            y = below ? avoid[hit + 3] + 12 : avoid[hit + 1] - 12;
          }
        } else if (mode === "glyph" && !targeted && hitsAvoid(x - 6, y - 6, x + 6, y + 6) !== -1) {
          mode = "hidden"; // never draw a marker over the HUD's own panels
        }

        // Revealing: edge arrows that share a spot slide apart along the edge instead of merging.
        if (mode === "edge" && clusterOff) {
          const vertical = x <= EDGE_PADDING + 0.5 || x >= w - EDGE_PADDING - 0.5;
          for (let tries = 0; tries < 8; tries++) {
            const hit = leaders.some((L) => L.edge && Math.abs(L.x - x) < EDGE_MERGE_PX && Math.abs(L.y - y) < EDGE_MERGE_PX);
            if (!hit) break;
            if (vertical) y = Math.min(h - EDGE_PADDING, y + EDGE_MERGE_PX + 8);
            else x = Math.min(w - EDGE_PADDING, x + EDGE_MERGE_PX + 30);
          }
        }
        // Cluster: a marker on top of a more important one folds into it as "+N".
        if ((mode === "glyph" || mode === "edge") && !clusterOff && !targeted && !poi.focused) {
          const r = mode === "edge" ? EDGE_MERGE_PX : CLUSTER_PX;
          let host = -1;
          for (let k = 0; k < leaders.length; k++) {
            const L = leaders[k];
            if (L.edge === (mode === "edge") && Math.abs(L.x - x) < r && Math.abs(L.y - y) < r) { host = k; break; }
          }
          if (host >= 0) {
            leaders[host].n++;
            mode = "hidden";
          }
        }
        if (mode === "glyph" || mode === "edge") leaders.push({ x, y, m, n: 0, edge: mode === "edge", badge: poi.badge });

        // ── Classes and position ──────────────────────────────────────────
        const cls = `mk mk--${poi.category} mk--${mode}${targeted ? " mk--target" : ""}${poi.focused ? " mk--focus" : ""}` +
          `${poi.occluded && !targeted ? " mk--occluded" : ""}${poi.active ? " mk--active" : ""}${poi.tracked ? " mk--tracked" : ""}`;
        if (m.cls !== cls) { m.el.className = cls; m.cls = cls; }
        if (mode === "hidden") continue;
        const tf = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        if (m.tf !== tf) { m.el.style.transform = tf; m.tf = tf; }
        const tint = poi.tint ?? "";
        if (m.tint !== tint) { m.el.style.setProperty("--mk-tint", tint || null); m.tint = tint; }
        const initial = poi.initial ?? "";
        if (m.initialText !== initial) { m.initial.textContent = initial; m.initialText = initial; }
        if (mode === "edge") m.pointer.style.transform = `rotate(${poi.edgeAngle}rad)`;
        const bracketR = mode === "bracket" ? `${Math.round(radiusPx * 1.08 + 4)}px` : "";
        if (m.bracketR !== bracketR) { m.el.style.setProperty("--mk-r", bracketR || null); m.bracketR = bracketR; }

        // ── Label ─────────────────────────────────────────────────────────
        const named = mode !== "edge" && (targeted || poi.focused || (poi.labelled && !poi.occluded));
        if (m.nameShown !== named) { m.name.style.display = named ? "" : "none"; m.nameShown = named; }
        if (m.nameText !== poi.name) { m.name.textContent = poi.name; m.nameText = poi.name; }
        const distText = poi.bearing ? "" : formatDistance(poi.distanceKm);
        if (m.distText !== distText) { m.dist.textContent = distText; m.distText = distText; }

        const offY = mode === "bracket" ? Math.min(h * 0.4, radiusPx * 1.08 + 8) : 10 * scale;
        const labelTf = `translate(-50%, ${offY.toFixed(0)}px)`;
        if (m.labelTf !== labelTf) { m.label.style.transform = labelTf; m.labelTf = labelTf; }

        // Estimated box (10 px caps ≈ 7 px per glyph): no layout reads per frame.
        const chars = Math.max(named ? poi.name.length : 0, distText.length) + 3;
        const half = (chars * 3.5 + 4) * scale;
        const t = y + offY, b = t + (named ? 26 : 13) * scale;
        const clear = mode === "edge" || targeted || (!hitsPlaced(x - half, t, x + half, b) && hitsAvoid(x - half, t, x + half, b) === -1);
        if (clear) { m.clearSince ||= now; m.conflictSince = 0; } else { m.conflictSince ||= now; m.clearSince = 0; }
        const visible = m.labelVisible ? clear || now - m.conflictSince < LABEL_HIDE_MS : clear && now - m.clearSince >= LABEL_SHOW_MS;
        if (visible && placedN < MAX_LABELS && mode !== "edge") {
          const o = placedN++ * 4;
          placed[o] = x - half; placed[o + 1] = t; placed[o + 2] = x + half; placed[o + 3] = b;
        }
        if (m.labelVisible !== visible) { m.label.style.visibility = visible ? "" : "hidden"; m.labelVisible = visible; }
      }

      // Cluster counts and body badges ("▪ 2": your structures out of local range).
      for (let k = 0; k < leaders.length; k++) {
        const L = leaders[k];
        const badge = L.badge;
        const extra = `${L.n > 0 ? `+${L.n}` : ""}${badge > 0 ? `${L.n > 0 ? " " : ""}▪${badge}` : ""}`;
        if (L.m.extraText !== extra) { L.m.extra.textContent = extra; L.m.extraText = extra; }
      }
    };

    poiBuffer.flush = flush;
    return () => {
      window.clearInterval(avoidTimer);
      poiBuffer.flush = null;
      el.innerHTML = "";
      markers.clear();
    };
  }, []);

  return <div ref={containerRef} className="poi-markers" data-scale={prefs.scale} data-reveal={reveal ? "1" : "0"}
    style={{ "--mk-scale": prefs.scale } as React.CSSProperties} />;
}

function createMarker(id: string): MarkerEls {
  const el = document.createElement("div");
  el.dataset.id = id;
  const glyph = document.createElement("div");
  glyph.className = "mk__glyph";
  const initial = document.createElement("span");
  initial.className = "mk__initial";
  glyph.appendChild(initial);
  const carets = document.createElement("div");
  carets.className = "mk__carets";
  const brackets = document.createElement("div");
  brackets.className = "mk__brackets";
  const pointer = document.createElement("div");
  pointer.className = "mk__pointer";
  const extra = document.createElement("span");
  extra.className = "mk__extra";
  const label = document.createElement("div");
  label.className = "mk__label";
  const name = document.createElement("div");
  name.className = "mk__name";
  name.style.display = "none";
  const dist = document.createElement("div");
  dist.className = "mk__dist";
  label.append(name, dist);
  el.append(brackets, carets, glyph, pointer, extra, label);
  return { el, glyph, initial, pointer, label, name, dist, extra, cls: "", tf: "", labelTf: "", nameText: "", distText: "", extraText: "",
    nameShown: false, labelVisible: true, conflictSince: 0, clearSince: 0, bracketR: "", tint: "", initialText: "" };
}
