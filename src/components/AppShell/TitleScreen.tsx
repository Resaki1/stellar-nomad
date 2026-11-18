"use client";

// Not the "@/audio" barrel: it pulls the emitter graph (three.js) into the title bundle.
import { playAudio } from "@/audio/voices";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import Panel from "@/components/HUD/Shell/Panel";
import { candidateWorldIds, listWorldsForTitle } from "@/save/boot";
import { deleteWorld, exportWorld, importWorld } from "@/save/saveDb";
import { getLocalPlayerId } from "@/save/playerId";
import type { Difficulty, SaveMeta } from "@/save/types";
import { markTitleInteractive } from "./appState";
import StarBackdrop from "./StarBackdrop";
import type { StartTarget } from "./AppShell";

const TitleSettings = lazy(() => import("./TitleSettings"));

type View = "menu" | "new" | "load" | "settings";

const DIFFICULTIES: { id: Difficulty; label: string; blurb: string }[] = [
  { id: "explorer", label: "Explorer", blurb: "Forgiving: 25 % less propellant use, half collision damage, cooler work, richer yields, a larger recovery allowance." },
  { id: "standard", label: "Standard", blurb: "The intended balance of risk and reward." },
  { id: "hard", label: "Hard", blurb: "Thin margins: 25 % more propellant use, harder impacts, hotter work, a smaller recovery allowance." },
];
const DIFFICULTY_LABEL: Record<Difficulty, string> = { explorer: "Explorer", standard: "Standard", hard: "Hard" };

const randomSeed = (): number => (Math.random() * 2 ** 32) >>> 0;

function formatPlayTime(s: number): string {
  const m = Math.floor(s / 60);
  if (m < 1) return "< 1 min";
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Up/Down moves focus between the `[data-nav]` buttons inside the list. */
function arrowNav(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-nav]"));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (items.length === 0) return;
  e.preventDefault();
  const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next].focus();
  playAudio("hover.tick");
}

/** Click sounds for buttons tagged `data-sfx`; panels play their own open/close and action sounds. */
function clickSfx(e: MouseEvent<HTMLElement>): void {
  const kind = (e.target as HTMLElement).closest<HTMLElement>("[data-sfx]")?.dataset.sfx;
  if (kind) playAudio(kind === "hard" ? "click.hard" : "click.soft");
}

/** Tick when the pointer enters a main-menu item (not when moving inside it). */
function hoverSfx(e: MouseEvent<HTMLElement>): void {
  const item = (e.target as HTMLElement).closest("[data-nav]");
  if (item && !item.contains(e.relatedTarget as Node | null)) playAudio("hover.tick");
}

async function download(world: SaveMeta): Promise<void> {
  const blob = new Blob([await exportWorld(world.id)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${world.name.replace(/[^\w-]+/g, "_")}.stellar-nomad.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

type Props = { onStart: (t: StartTarget) => Promise<void> };

export default function TitleScreen({ onStart }: Props) {
  const [worlds, setWorlds] = useState<SaveMeta[] | null>(null);
  const [continueId, setContinueId] = useState<string | null>(null);
  const [view, setView] = useState<View>("menu");
  const [status, setStatus] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listWorldsForTitle();
      const ids = await candidateWorldIds(null);
      setWorlds(list);
      setContinueId(ids[0] ?? null);
    } catch (e) {
      console.error("[save] could not list worlds", e);
      setWorlds([]);
      setStatus("Saved worlds could not be read in this browser.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (worlds === null) return;
    markTitleInteractive();
    menuRef.current?.querySelector<HTMLElement>("[data-nav]")?.focus();
  }, [worlds]);

  const open = (v: View) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setView(v);
  };
  const back = useCallback(() => {
    setView("menu");
    requestAnimationFrame(() => {
      const el = returnFocus.current?.isConnected ? returnFocus.current : null;
      (el ?? menuRef.current?.querySelector<HTMLElement>("[data-nav]"))?.focus();
    });
  }, []);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const meta = await importWorld(await file.text(), getLocalPlayerId());
      setStatus(`Imported “${meta.name}”.`);
      await refresh();
    } catch (e) {
      setStatus(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const cont = worlds?.find((w) => w.id === continueId) ?? null;
  const hasWorlds = (worlds?.length ?? 0) > 0;

  return (
    <div className="shell-title" onClickCapture={clickSfx}>
      <StarBackdrop />
      <main className="shell-title__main" inert={view !== "menu"}>
        <header className="shell-title__brand">
          <h1 className="shell-title__name">Stellar Nomad</h1>
          <div className="shell-title__rule" aria-hidden />
        </header>

        {worlds !== null && (
          <nav aria-label="Main menu">
            <div className="shell-title__menu" ref={menuRef} onKeyDown={arrowNav} onMouseOver={hoverSfx}>
              {cont && (
                <button
                  type="button"
                  data-nav
                  data-sfx="hard"
                  className="shell-menu__item shell-menu__item--primary"
                  onClick={() => void onStart({ kind: "world", worldId: cont.id })}
                >
                  <span className="shell-menu__label">Continue</span>
                  <span className="shell-menu__meta">
                    {cont.name} · <span className="shell-num">{formatPlayTime(cont.playTimeS)}</span>
                  </span>
                </button>
              )}
              <button
                type="button"
                data-nav
                className={`shell-menu__item${hasWorlds ? "" : " shell-menu__item--primary"}`}
                onClick={() => open("new")}
              >
                <span className="shell-menu__label">New world</span>
              </button>
              {hasWorlds && (
                <button type="button" data-nav className="shell-menu__item" onClick={() => open("load")}>
                  <span className="shell-menu__label">Load world</span>
                  <span className="shell-menu__meta">
                    <span className="shell-num">{worlds.length}</span> saved
                  </span>
                </button>
              )}
              <button type="button" data-nav data-sfx="soft" className="shell-menu__item" onClick={() => fileRef.current?.click()}>
                <span className="shell-menu__label">Import save</span>
              </button>
              <button type="button" data-nav className="shell-menu__item" onClick={() => open("settings")}>
                <span className="shell-menu__label">Settings</span>
              </button>
            </div>
          </nav>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => void onImport(e.target.files?.[0])}
        />
        <p className="shell-title__status" role="status">
          {status}
        </p>
      </main>
      <footer className="shell-title__hints" aria-hidden>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> select
        </span>
        <span>
          <kbd>Enter</kbd> confirm
        </span>
        <span>
          <kbd>Esc</kbd> back
        </span>
      </footer>

      {view === "new" && (
        <NewWorldPanel
          defaultName={`World ${(worlds?.length ?? 0) + 1}`}
          onBack={back}
          onCreate={(o) => void onStart({ kind: "new", ...o })}
        />
      )}
      {view === "load" && worlds && (
        <LoadWorldPanel
          worlds={worlds}
          onBack={back}
          onPlay={(id) => void onStart({ kind: "world", worldId: id })}
          onChanged={refresh}
        />
      )}
      {view === "settings" && (
        <Suspense fallback={null}>
          <TitleSettings onClose={back} />
        </Suspense>
      )}
    </div>
  );
}

function NewWorldPanel({
  defaultName,
  onBack,
  onCreate,
}: {
  defaultName: string;
  onBack: () => void;
  onCreate: (o: { name: string; seed: number; difficulty: Difficulty }) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [seed, setSeed] = useState(() => String(randomSeed()));
  const [difficulty, setDifficulty] = useState<Difficulty>("standard");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const seedNum = Number(seed);
  const seedOk = /^\d+$/.test(seed.trim()) && seedNum <= 0xffffffff;
  const nameOk = name.trim().length > 0;

  return (
    <Panel
      title="New world"
      tier={2}
      width={520}
      onClose={onBack}
      footerSlot={
        <>
          <div className="panel__footer-left">
            <button type="button" className="panel__action panel__action--secondary" onClick={onBack}>
              <span className="panel__action-label">Back</span>
            </button>
          </div>
          <div className="panel__footer-right">
            <button
              type="submit"
              form="shell-new-world"
              data-sfx="hard"
              className="panel__action panel__action--primary"
              disabled={!nameOk || !seedOk}
            >
              <span className="panel__action-label">Launch</span>
            </button>
          </div>
        </>
      }
    >
      <form
        id="shell-new-world"
        className="shell-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (nameOk && seedOk) onCreate({ name: name.trim(), seed: seedNum >>> 0, difficulty });
        }}
      >
        <label className="shell-field">
          <span className="shell-field__label">Name</span>
          <input
            ref={nameRef}
            className="shell-input"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="shell-field">
          <label className="shell-field__label" htmlFor="shell-seed">
            Seed
          </label>
          <div className="shell-field__row">
            <input
              id="shell-seed"
              className="shell-input shell-input--mono"
              value={seed}
              inputMode="numeric"
              aria-invalid={!seedOk}
              aria-describedby="shell-seed-hint"
              onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ""))}
              autoComplete="off"
            />
            <button type="button" data-sfx="soft" className="shell-btn" onClick={() => setSeed(String(randomSeed()))}>
              Randomize
            </button>
          </div>
          <span id="shell-seed-hint" className="shell-field__hint">
            {seedOk ? "Whole number, 0 to 4 294 967 295." : "Enter a whole number from 0 to 4 294 967 295."}
          </span>
        </div>
        <fieldset className="shell-field shell-difficulty">
          <legend className="shell-field__label">Difficulty</legend>
          {DIFFICULTIES.map((d) => (
            <label key={d.id} className={`shell-choice${difficulty === d.id ? " shell-choice--on" : ""}`}>
              <input
                type="radio"
                name="difficulty"
                value={d.id}
                checked={difficulty === d.id}
                onChange={() => setDifficulty(d.id)}
              />
              <span className="shell-choice__label">{d.label}</span>
              <span className="shell-choice__blurb">{d.blurb}</span>
            </label>
          ))}
          <p className="shell-field__hint">Fixed for this world. Loss and recovery work the same on every setting.</p>
        </fieldset>
      </form>
    </Panel>
  );
}

function LoadWorldPanel({
  worlds,
  onBack,
  onPlay,
  onChanged,
}: {
  worlds: SaveMeta[];
  onBack: () => void;
  onPlay: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<SaveMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** First list button, or the panel's Back once the last world is gone. */
  const focusList = () =>
    (listRef.current?.querySelector<HTMLElement>("[data-nav]") ??
      panelRef.current?.querySelector<HTMLElement>(".panel__footer button"))?.focus();
  const deleteFrom = useRef<string | null>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-nav]")?.focus();
  }, []);

  const closeConfirm = useCallback(() => {
    setConfirm(null);
    setDeleteError(null);
    const id = deleteFrom.current;
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-delete="${id}"]`)?.focus() ??
      listRef.current?.querySelector<HTMLElement>("[data-nav]")?.focus(),
    );
  }, []);

  const doDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await deleteWorld(confirm.id);
      setConfirm(null);
      setDeleteError(null);
      await onChanged();
      requestAnimationFrame(focusList);
    } catch (e) {
      setDeleteError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="shell__contents" ref={panelRef} inert={!!confirm}>
        <Panel
          title="Load world"
          tier={2}
          width={640}
          onClose={onBack}
          closeOnEsc={!confirm}
          closeOnBackdrop={!confirm}
          secondaryAction={{ label: "Back", onClick: onBack, variant: "secondary" }}
        >
          {worlds.length === 0 ? (
            <p className="shell-empty">No saved worlds in this browser.</p>
          ) : (
            <ul className="shell-worlds" ref={listRef} onKeyDown={arrowNav} aria-label="Saved worlds">
              {worlds.map((w) => (
                <li key={w.id} className="shell-world">
                  <div className="shell-world__info">
                    <span className="shell-world__name">{w.name}</span>
                    <span className="shell-world__meta">
                      <span className="shell-tag">{DIFFICULTY_LABEL[w.difficulty]}</span>
                      <span>
                        played <span className="shell-num">{formatWhen(w.lastPlayedAt)}</span>
                      </span>
                      <span className="shell-num">{formatPlayTime(w.playTimeS)}</span>
                    </span>
                  </div>
                  <div className="shell-world__actions">
                    <button
                      type="button"
                      data-nav
                      data-sfx="hard"
                      className="shell-btn shell-btn--primary"
                      aria-label={`Play ${w.name}`}
                      onClick={() => onPlay(w.id)}
                    >
                      Play
                    </button>
                    <button
                      type="button"
                      data-sfx="soft"
                      className="shell-btn"
                      aria-label={`Export ${w.name}`}
                      onClick={() => void download(w).catch((e: unknown) => setError(String(e)))}
                    >
                      Export
                    </button>
                    <button
                      type="button"
                      data-delete={w.id}
                      className="shell-btn shell-btn--danger"
                      aria-label={`Delete ${w.name}`}
                      onClick={() => {
                        deleteFrom.current = w.id;
                        setConfirm(w);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="shell-empty" role="alert">
              {error}
            </p>
          )}
        </Panel>
      </div>
      {confirm && (
        <ConfirmDelete
          world={confirm}
          busy={busy}
          error={deleteError}
          onCancel={closeConfirm}
          onConfirm={() => void doDelete()}
        />
      )}
    </>
  );
}

function ConfirmDelete({
  world,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  world: SaveMeta;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <Panel
      title="Delete world?"
      tier={2}
      width={440}
      onClose={onCancel}
      footerSlot={
        <>
          <div className="panel__footer-left">
            <button ref={cancelRef} type="button" className="panel__action panel__action--secondary" onClick={onCancel}>
              <span className="panel__action-label">Cancel</span>
            </button>
          </div>
          <div className="panel__footer-right">
            <button type="button" data-sfx="hard" className="panel__action panel__action--danger" onClick={onConfirm} disabled={busy}>
              <span className="panel__action-label">{busy ? "Deleting…" : "Delete permanently"}</span>
            </button>
          </div>
        </>
      }
    >
      <p className="shell-confirm">
        <strong>{world.name}</strong> and all progress in it will be deleted from this browser. This cannot be
        undone. Export it first if you might want it back.
      </p>
      {error && (
        <p className="shell-empty" role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}
