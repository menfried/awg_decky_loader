import { callable, definePlugin, FileSelectionType, openFilePicker, useQuickAccessVisible } from "@decky/api";
import { DialogBody, DialogButton, DialogHeader, Focusable, ModalRoot, PanelSection, PanelSectionRow, showModal, staticClasses } from "@decky/ui";
import React, { useEffect, useRef, useState } from "react";

type Profile = { id: string; name: string; active: boolean };
type Traffic = { id: string; time: number; rx: number; tx: number };
type Rate = Pick<Traffic, "rx" | "tx">;
type State = { profiles: Profile[]; ready: boolean; error: string; traffic: Traffic | null; handshakeAge: number | null };
type Action = "status" | "import" | "up" | "down" | "delete";
type Change = Exclude<Action, "status">;

const manage = callable<[Action, string], State>("manage");
const usePanelVisible = useQuickAccessVisible ?? (() => true);
const fullWidth: React.CSSProperties = { width: "100%", minWidth: 0, boxSizing: "border-box" };
const buttonStyles = `
  .amneziawg-active { --awg-button: #23604b; --awg-focus: #347b62; --awg-ring: #a4f3ce; }
  .amneziawg-delete { --awg-button: #9b303b; --awg-focus: #b64551; --awg-ring: #ffd3d7; }
  .amneziawg-cancel { --awg-button: #424b57; --awg-focus: #596575; --awg-ring: #e0e8f0; }
  .amneziawg-color {
    background: var(--awg-button) !important;
    color: #fff !important;
  }
  .amneziawg-active { box-shadow: 0 0 10px #4eca8c66; }
  .amneziawg-delete, .amneziawg-cancel {
    padding-inline: 6px !important;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .amneziawg-color:not([disabled]):is(:hover, :focus, :focus-within, .gpfocus) {
    background: var(--awg-focus) !important;
    outline: 2px solid var(--awg-ring) !important;
    outline-offset: -2px;
  }
`;
const progress: Record<Change, string> = {
  import: "Импортируем…", up: "Подключаем…", down: "Отключаем…", delete: "Удаляем…",
};
const colors = { rx: "#78c7ff", tx: "#86dfb7" };
let lastSelectedId: string | undefined;

function formatRate(value: number) {
  if (value >= 1048576) return (value / 1048576).toFixed(1) + " МиБ/с";
  if (value >= 1024) return (value / 1024).toFixed(1) + " КиБ/с";
  return Math.round(value) + " Б/с";
}

function TrafficChart({ samples, active }: { samples: Rate[]; active: boolean }) {
  const latest = samples.at(-1);
  const peak = Math.max(1, ...samples.map(({ rx, tx }) => Math.max(rx, tx)));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
        <span style={{ color: colors.rx }}>↓ {latest ? formatRate(latest.rx) : "—"}</span>
        <span style={{ color: colors.tx }}>↑ {latest ? formatRate(latest.tx) : "—"}</span>
      </div>
      <div aria-hidden="true" style={{
        display: "grid", gridTemplateColumns: "repeat(24, minmax(0, 1fr))", gap: 2,
        height: 48, borderBottom: "1px solid #536071", background: "rgba(0,0,0,.24)",
      }}>
        {samples.map((sample, index) => (
          <div key={index} style={{
            display: "flex", alignItems: "end", gap: 1, gridColumn: 25 - samples.length + index,
          }}>
            {(["rx", "tx"] as const).map((direction) => (
              <div key={direction} style={{
                flex: 1, height: (sample[direction] / peak * 100) + "%",
                background: colors[direction],
              }} />
            ))}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, opacity: 0.75 }}>
        {active ? "Трафик туннеля · каждые 5 с" : "График появится после подключения"}
      </div>
    </div>
  );
}

function Content() {
  const visible = usePanelVisible();
  const [state, setState] = useState<State>();
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [pending, setPending] = useState<Change>();
  const [selectedId, setSelectedId] = useState(lastSelectedId);
  const [profilesExpanded, setProfilesExpanded] = useState(false);
  const [ip, setIP] = useState<string>();
  const [samples, setSamples] = useState<Rate[]>([]);
  const previousTraffic = useRef<Traffic | null>(null);
  const changing = useRef(false);
  const polling = useRef(false);
  const revision = useRef(0);
  const profiles = state?.profiles ?? [];
  const connected = profiles.find((profile) => profile.active);
  const selected = profiles.find(({ id }) => id === selectedId) ?? connected ?? profiles[0];
  const handshakeAge = state?.handshakeAge;
  const serverConfirmed = Boolean(connected && handshakeAge != null && handshakeAge < 180);
  const tunnelStatus = serverConfirmed ? "Связь подтверждена"
    : handshakeAge == null ? "Связь с сервером не подтверждена"
    : "Нет свежего ответа от сервера";

  function selectProfile(id: string) {
    lastSelectedId = id;
    setSelectedId(id);
    setProfilesExpanded(false);
  }

  function recordTraffic(next: Traffic | null) {
    const previous = previousTraffic.current;
    previousTraffic.current = next;
    if (!next || !previous || next.id !== previous.id || next.rx < previous.rx || next.tx < previous.tx) {
      setSamples((existing) => existing.length ? [] : existing);
      return;
    }
    const elapsed = next.time - previous.time;
    if (elapsed < 1) return;
    setSamples((existing) => [...existing.slice(-23), {
      rx: (next.rx - previous.rx) / elapsed,
      tx: (next.tx - previous.tx) / elapsed,
    }]);
  }

  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let request: AbortController | undefined;

    async function refresh() {
      if (changing.current || polling.current) return;
      const currentRevision = revision.current;
      polling.current = true;
      request = new AbortController();
      const timeout = window.setTimeout(() => request?.abort(), 4000);
      const publicIP = fetch("https://api64.ipify.org", { cache: "no-store", signal: request.signal })
        .then((response) => response.ok ? response.text() : undefined)
        .then((value) => value && /^[\da-f:.]{3,45}$/i.test(value.trim()) ? value.trim() : undefined)
        .catch(() => undefined);

      try {
        const next = await manage("status", "");
        if (stopped || currentRevision !== revision.current) return;
        setState(next);
        setStatusError(next.error);
        recordTraffic(next.traffic);
        const address = await publicIP;
        if (!stopped && currentRevision === revision.current) setIP(address ?? "Недоступен");
      } catch {
        if (!stopped && currentRevision === revision.current) setStatusError("Decky не получил ответ от плагина.");
      } finally {
        window.clearTimeout(timeout);
        request.abort();
        polling.current = false;
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      stopped = true;
      request?.abort();
      window.clearInterval(timer);
      previousTraffic.current = null;
      setSamples([]);
    };
  }, [visible]);

  async function perform(action: Change, value = "") {
    if (changing.current) return;
    changing.current = true;
    revision.current++;
    setPending(action);
    setError("");
    if (action === "up" || action === "down") setIP(undefined);
    try {
      if (action === "import") {
        try {
          const selection = await openFilePicker(FileSelectionType.FILE, "/home/deck", true, true);
          value = selection.path;
        } catch {
          return;
        }
      }
      const next = await manage(action, value);
      if (action === "import" && !next.error) {
        const imported = next.profiles.find((profile) => !profiles.some(({ id }) => id === profile.id));
        if (imported) selectProfile(imported.id);
      }
      setState(next);
      setError(next.error);
      setStatusError("");
      if (!next.traffic || next.traffic.id !== previousTraffic.current?.id) {
        previousTraffic.current = next.traffic;
        setSamples([]);
      }
    } catch {
      setError("Decky не получил ответ от плагина.");
    } finally {
      setPending(undefined);
      changing.current = false;
    }
  }

  function confirmDelete(profile: Profile) {
    const cancel = () => modal.Close();
    const modal = showModal(
      <ModalRoot onCancel={cancel} onEscKeypress={cancel} bHideCloseIcon>
        <style>{buttonStyles}</style>
        <DialogHeader>Удалить профиль?</DialogHeader>
        <DialogBody>
          <div style={{ marginBottom: 12, overflowWrap: "anywhere" }}>{profile.name}</div>
          <Focusable flow-children="right" onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }} style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            <DialogButton style={fullWidth} className="amneziawg-color amneziawg-delete" onClick={() => {
              modal.Close();
              void perform("delete", profile.id);
            }}>
              Удалить
            </DialogButton>
            <DialogButton style={fullWidth} className="amneziawg-color amneziawg-cancel" onClick={cancel}>
              Отмена
            </DialogButton>
          </Focusable>
        </DialogBody>
      </ModalRoot>,
      undefined,
      { bNeverPopOut: true },
    );
  }

  const busy = pending !== undefined;
  return (
    <>
      <style>{buttonStyles}</style>
      <PanelSection>
        <PanelSectionRow>
          <div style={{ display: "grid", gap: 8, width: "100%", minWidth: 0 }}>
            <DialogButton style={fullWidth} className={serverConfirmed ? "amneziawg-color amneziawg-active" : undefined}
              disabled={busy || !state?.ready || !selected} onClick={() => {
              if (connected) void perform("down", connected.id);
              else if (selected) void perform("up", selected.id);
            }}>
              {pending === "up" || pending === "down" ? progress[pending] : connected ? "Отключиться" : "Подключиться"}
            </DialogButton>
            {connected && <div style={{ color: serverConfirmed ? colors.tx : "#f3cc83", fontSize: 12, overflowWrap: "anywhere" }}>
              {tunnelStatus} · {connected.name}
            </div>}
            <div style={{ height: 4 }} />
            {selected && (
              <DialogButton style={fullWidth} disabled={busy || profiles.length < 2} onClick={() => {
                setProfilesExpanded(!profilesExpanded);
              }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selected.name}{profiles.length > 1 ? (profilesExpanded ? " ▴" : " ▾") : ""}
                </span>
              </DialogButton>
            )}
            {profilesExpanded && profiles.length > 1 && (
              <Focusable flow-children="down" style={{
                display: "grid", gap: 4, padding: 6, borderRadius: 4, background: "rgba(0,0,0,.22)",
              }}>
                {profiles.map((profile) => (
                  <DialogButton key={profile.id} disabled={busy} onClick={() => selectProfile(profile.id)}
                    style={{
                      ...fullWidth, textAlign: "left", overflowWrap: "anywhere",
                      borderLeft: profile.id === selected?.id ? "3px solid #78c7ff" : "3px solid transparent",
                    }}>
                    {profile.name}
                  </DialogButton>
                ))}
              </Focusable>
            )}
            <DialogButton style={fullWidth} disabled={busy} onClick={() => void perform("import")}>
              {pending === "import" ? progress.import : "Добавить .conf"}
            </DialogButton>
            {selected && (
              <DialogButton style={fullWidth} disabled={busy || selected.active} onClick={() => confirmDelete(selected)}>
                {pending === "delete" ? progress.delete : "Удалить профиль"}
              </DialogButton>
            )}
            {(error || statusError) && (
              <div role="alert" style={{ color: "#ffbdaf", overflowWrap: "anywhere" }}>{error || statusError}</div>
            )}
          </div>
        </PanelSectionRow>
      </PanelSection>
      <PanelSection title="Сеть">
        <PanelSectionRow>
          <div style={{ display: "grid", gap: 12, padding: "8px 0" }}>
            <div style={{ overflowWrap: "anywhere" }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 3 }}>Внешний IP</div>
              <div style={{ fontFamily: "monospace" }}>{ip ?? "Проверяем…"}</div>
            </div>
            <TrafficChart samples={samples} active={Boolean(connected)} />
          </div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => ({
  name: "AmneziaWG",
  titleView: <div className={staticClasses.Title}>AmneziaWG</div>,
  content: <Content />,
  icon: <span aria-hidden="true" style={{
    display: "inline-grid", justifyItems: "center", width: 20, height: 20, alignContent: "center",
  }}>
    <span style={{ boxSizing: "border-box", width: 9, height: 7, border: "2px solid currentColor", borderRadius: "5px 5px 0 0", borderBottom: 0 }} />
    <span style={{ display: "grid", placeItems: "center", width: 15, height: 10, background: "currentColor", borderRadius: 2 }}>
      <span style={{ width: 3, height: 5, background: "#182532", borderRadius: 2 }} />
    </span>
  </span>,
}));
