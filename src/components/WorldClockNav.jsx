import { useEffect, useMemo, useRef, useState } from "react";
import { Globe, Pin, Plus, X } from "lucide-react";
import { useApp } from "../context/AppContext";
import { useTeam } from "../context/TeamContext";
import Popover from "./goals/Popover";
import { ClockRow, CityTimezonePicker, PinnedClockHero } from "./worldclock/clockShared";
import { getWorldClockLocations, cityFromZone } from "../lib/worldClock";
import { localTimeLabel } from "../lib/timezone";

// Globe dropdown in the nav: the org's operating locations (shared, from
// teams.world_clock_locations) plus the user's own personal timezones (stored on
// user_settings.world_clock_personal). Any row can be pinned → its live time
// shows as a compact pill in the nav (user_settings.nav_pinned_tz). Reuses the
// shared ClockRow / CityTimezonePicker so it matches the office widget exactly.
export default function WorldClockNav({ dark }) {
  const { settings, updateSettingsField } = useApp();
  const { activeTeamId } = useTeam();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [orgLocs, setOrgLocs] = useState([]);
  const [, setTick] = useState(0);
  const btnRef = useRef(null);

  const personal = Array.isArray(settings.worldClockPersonal) ? settings.worldClockPersonal : [];
  const pinnedTz = settings.navPinnedTz || "";

  // Load org locations when the dropdown opens (a cheap direct fetch, off the
  // hot team-load path). Also load on mount when the PINNED zone isn't one of the
  // user's personal times — otherwise the nav pill can't find its org-curated
  // label and falls back to the city name until the dropdown is first opened.
  const pinnedNeedsOrg = !!pinnedTz && !personal.some((p) => p.tz === pinnedTz);
  useEffect(() => {
    if ((!open && !pinnedNeedsOrg) || !activeTeamId) return;
    let cancelled = false;
    getWorldClockLocations(activeTeamId).then(({ data }) => { if (!cancelled) setOrgLocs(data || []); });
    return () => { cancelled = true; };
  }, [open, pinnedNeedsOrg, activeTeamId]);

  // Keep the pinned pill + open dropdown ticking (30s is plenty for minutes).
  useEffect(() => {
    if (!open && !pinnedTz) return undefined;
    const id = setInterval(() => setTick((n) => (n + 1) % 1e9), 30000);
    return () => clearInterval(id);
  }, [open, pinnedTz]);

  // Org first, then personal; dedupe by zone so a personal copy of an org zone
  // doesn't double up. `personal` flags which rows the user can remove.
  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const l of orgLocs) if (l?.tz && !seen.has(l.tz)) { seen.add(l.tz); out.push({ ...l, personal: false }); }
    for (const l of personal) if (l?.tz && !seen.has(l.tz)) { seen.add(l.tz); out.push({ ...l, personal: true }); }
    return out;
  }, [orgLocs, personal]);

  const pinnedLabel = useMemo(() => {
    if (!pinnedTz) return "";
    return rows.find((r) => r.tz === pinnedTz)?.label || cityFromZone(pinnedTz);
  }, [pinnedTz, rows]);

  // The pinned zone is featured in the hero, so the plain list shows the rest.
  const otherRows = useMemo(() => rows.filter((r) => r.tz !== pinnedTz), [rows, pinnedTz]);

  const pin = (tz) => updateSettingsField({ navPinnedTz: tz });
  const unpin = () => updateSettingsField({ navPinnedTz: "" });
  const addPersonal = ({ city, tz }) => {
    setAdding(false);
    if (!tz || personal.some((p) => p.tz === tz)) return;
    const id = (() => { try { return crypto.randomUUID(); } catch { return `p_${Math.random().toString(36).slice(2)}`; } })();
    updateSettingsField({ worldClockPersonal: [...personal, { id, label: city || cityFromZone(tz), tz }] });
  };
  const removePersonal = (rowId) => updateSettingsField({ worldClockPersonal: personal.filter((p) => p.id !== rowId) });

  const fieldCls = dark
    ? "bg-[var(--color-surface)] border-[var(--color-border)] text-slate-100 placeholder:text-slate-500"
    : "bg-white border-slate-300 text-slate-800 placeholder:text-slate-400";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="World clock"
        className={`inline-flex items-center gap-1.5 rounded-full transition-colors shrink-0 ${
          pinnedTz ? "min-h-11 sm:min-h-0 px-2.5 py-1.5 text-xs font-semibold" : "w-11 h-11 sm:w-9 sm:h-9 justify-center"
        } ${
          dark ? "text-slate-300 hover:text-slate-100 hover:bg-white/5" : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
        }`}
      >
        <Globe className="w-5 h-5 sm:w-[18px] sm:h-[18px]" />
        {pinnedTz && (
          <span className="inline-flex items-center gap-1">
            <span className="max-w-[92px] truncate">{pinnedLabel}</span>
            <span className="tabular-nums">{localTimeLabel(pinnedTz)}</span>
          </span>
        )}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={btnRef} width={288} dark={dark}>
        <div className="px-1.5 py-1 flex items-center justify-between">
          <span className={`text-[11px] font-semibold uppercase tracking-wider ${dark ? "text-slate-400" : "text-slate-500"}`}>World clock</span>
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            title="Add a personal time"
            className={`inline-flex items-center gap-1 px-2 py-2 -my-1 sm:p-0 sm:m-0 rounded-md text-xs sm:text-[11px] font-medium ${dark ? "text-slate-300 hover:text-white" : "text-slate-600 hover:text-slate-900"}`}
          >
            <Plus className="w-4 h-4 sm:w-3.5 sm:h-3.5" /> Add
          </button>
        </div>

        {adding && (
          <div className="px-1.5 pb-1.5">
            <CityTimezonePicker dark={dark} fieldCls={fieldCls} onPick={addPersonal} placeholder="Add any city…" />
          </div>
        )}

        {pinnedTz && (
          <div className="px-1.5 pb-1.5">
            <PinnedClockHero tz={pinnedTz} label={pinnedLabel} dark={dark} onUnpin={unpin} />
          </div>
        )}

        {otherRows.length > 0 ? (
          <ul className="px-1">
            {otherRows.map((row) => (
              <ClockRow
                key={row.id || row.tz}
                loc={row}
                dark={dark}
                trailing={
                  <div className="flex items-center gap-0.5 shrink-0 pl-0.5">
                    <button
                      type="button"
                      onClick={() => pin(row.tz)}
                      title="Pin this time to the nav"
                      aria-pressed={false}
                      className={`p-2 sm:p-1 rounded ${
                        dark ? "text-slate-500 hover:text-slate-200 hover:bg-white/5" : "text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      <Pin className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                    </button>
                    {row.personal && (
                      <button
                        type="button"
                        onClick={() => removePersonal(row.id)}
                        title="Remove"
                        className={`p-2 sm:p-1 rounded ${dark ? "text-slate-500 hover:text-rose-400 hover:bg-white/5" : "text-slate-400 hover:text-rose-500 hover:bg-slate-100"}`}
                      >
                        <X className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                      </button>
                    )}
                  </div>
                }
              />
            ))}
          </ul>
        ) : !pinnedTz ? (
          <div className={`px-2 py-2 text-[11px] leading-snug ${dark ? "text-slate-500" : "text-slate-500"}`}>
            No times yet. Use <span className="font-medium">Add</span> to pin a city, or an admin can add the org's locations in the office World Clock.
          </div>
        ) : null}
      </Popover>
    </>
  );
}
