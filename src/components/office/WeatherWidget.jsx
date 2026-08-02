import { useCallback, useEffect, useState } from "react";
import {
  Sun, Moon, CloudSun, CloudMoon, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning,
  MapPin, Search, Loader2, LocateFixed, Settings2, Star, X,
} from "lucide-react";
import { geocodeCity, fetchWeather, weatherInfo } from "../../lib/weather";
import { useVisibilityPausedInterval } from "../../hooks/useVisibilityPausedInterval";
import WidgetSection from "./WidgetSection";

// WMO condition `kind` → lucide icon (shared with the chip). Mirrors the kiosk's
// WEATHER_ICONS so both surfaces read identically.
export const WEATHER_ICONS = {
  "clear-day": Sun, "clear-night": Moon, "partly-day": CloudSun, "partly-night": CloudMoon,
  cloudy: Cloud, fog: CloudFog, drizzle: CloudDrizzle, rain: CloudRain, snow: CloudSnow, storm: CloudLightning,
};

const KEY = "ql_weather";
const SYNC_EVENT = "mango:weather-cfg";
const locKey = (l) => `${l.lat},${l.lon}`;

function normUnit(u) { return u === "celsius" ? "celsius" : "fahrenheit"; }
function normLoc(l) {
  if (!l || l.lat == null || l.lon == null) return null;
  return { name: l.name || "", lat: l.lat, lon: l.lon };
}
function loadCfg() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (v && Array.isArray(v.locations)) return { locations: v.locations.map(normLoc).filter(Boolean), unit: normUnit(v.unit) };
    if (v && v.lat != null) return { locations: [{ name: v.name || "", lat: v.lat, lon: v.lon }], unit: normUnit(v.unit) }; // migrate old single-city
  } catch { /* */ }
  return { locations: [], unit: "fahrenheit" };
}
function saveCfg(c) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* */ }
  try { window.dispatchEvent(new CustomEvent(SYNC_EVENT)); } catch { /* */ }
}

// Weather config + live data. Config (a list of cities + unit) is per-device
// (localStorage); a custom event keeps the card + the strip chip in sync when it
// changes. The FIRST location is the "primary" (featured big); the rest ride
// under it as compact cards. Refetches every 20 min (paused when tab hidden).
export function useWeather() {
  const [cfg, setCfg] = useState(loadCfg);
  const [wx, setWx] = useState({}); // locKey → weather data
  const [err, setErr] = useState(false);
  const { locations, unit } = cfg;
  const hasPlace = locations.length > 0;
  const sig = locations.map(locKey).join("|") + ":" + unit;

  // Re-read the shared config when another instance changes it.
  useEffect(() => {
    const onSync = () => setCfg(loadCfg());
    window.addEventListener(SYNC_EVENT, onSync);
    return () => window.removeEventListener(SYNC_EVENT, onSync);
  }, []);

  const reload = useCallback(async () => {
    if (!locations.length) { setWx({}); return; }
    try {
      setErr(false);
      const results = {};
      await Promise.all(locations.map(async (l) => {
        try { results[locKey(l)] = await fetchWeather(l.lat, l.lon, unit); } catch { /* */ }
      }));
      setWx(results);
    } catch { setErr(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useEffect(() => { reload(); }, [reload]);
  useVisibilityPausedInterval(reload, 20 * 60 * 1000, { enabled: hasPlace });

  const mutate = (fn) => setCfg((c) => { const n = fn(c); if (!n) return c; saveCfg(n); return n; });
  const addPlace = (p) => mutate((c) => {
    const loc = normLoc(p);
    if (!loc || c.locations.some((l) => locKey(l) === locKey(loc))) return null;
    return { ...c, locations: [...c.locations, loc] };
  });
  const removePlace = (i) => mutate((c) => ({ ...c, locations: c.locations.filter((_, j) => j !== i) }));
  const makePrimary = (i) => mutate((c) => {
    if (i <= 0 || i >= c.locations.length) return null;
    const arr = c.locations.slice();
    const [m] = arr.splice(i, 1);
    arr.unshift(m);
    return { ...c, locations: arr };
  });
  const setUnit = (u) => mutate((c) => ({ ...c, unit: normUnit(u) }));

  const primary = locations[0] || null;
  return {
    cfg, wx, err, locations, unit, hasPlace,
    primary, primaryData: primary ? wx[locKey(primary)] : null,
    addPlace, removePlace, makePrimary, setUnit,
  };
}

// City search / "locate me". Clears its own field after a pick so several cities
// can be added back-to-back (the multi-location manager reuses it).
function CityPicker({ dark, onPick, onCancel }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const search = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true); setNotFound(false);
    try {
      const hit = await geocodeCity(q);
      if (hit) { onPick({ name: hit.name, lat: hit.lat, lon: hit.lon }); setQuery(""); }
      else setNotFound(true);
    } catch { setNotFound(true); }
    setBusy(false);
  };
  const locate = () => {
    if (!navigator.geolocation) return;
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { onPick({ name: "My location", lat: pos.coords.latitude, lon: pos.coords.longitude }); setQuery(""); setBusy(false); },
      () => setBusy(false),
      { timeout: 8000 },
    );
  };
  const inputCls = dark
    ? "bg-[var(--color-surface)] border-[var(--color-border)] text-slate-100 placeholder:text-slate-500"
    : "bg-white border-slate-200 text-slate-700 placeholder:text-slate-400";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            autoFocus
            onChange={(e) => { setQuery(e.target.value); setNotFound(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") search(); }}
            placeholder="Search a city…"
            className={`w-full pl-7 pr-2 py-1.5 rounded-md border text-xs outline-none focus:ring-1 focus:ring-[var(--color-accent)] ${inputCls}`}
          />
        </div>
        <button
          type="button"
          onClick={search}
          disabled={!query.trim() || busy}
          aria-label="Search"
          className="shrink-0 p-1.5 rounded-md text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
        </button>
      </div>
      {notFound && <p className="text-[11px] text-[var(--color-danger)]">No match — try a bigger nearby city.</p>}
      <div className="flex items-center gap-2">
        {navigator.geolocation && (
          <button type="button" onClick={locate} className={`inline-flex items-center gap-1 text-[11px] font-medium ${dark ? "text-slate-300 hover:text-white" : "text-slate-600 hover:text-slate-900"}`}>
            <LocateFixed className="w-3.5 h-3.5" /> Use my location
          </button>
        )}
        {onCancel && <button type="button" onClick={onCancel} className="ml-auto text-[11px] text-slate-400 hover:text-slate-500">Cancel</button>}
      </div>
    </div>
  );
}

// The featured (primary) location — big icon + temp + condition, feels/wind, and
// a 3-day forecast. Carries the header controls (unit toggle + manage gear).
function WeatherHero({ loc, data, unitF, err, dark, onToggleUnit, onEdit }) {
  const cur = data?.current;
  const info = cur ? weatherInfo(cur.weather_code, cur.is_day) : null;
  const Icon = info ? (WEATHER_ICONS[info.kind] || Cloud) : Cloud;
  const daily = data?.daily;
  const muted = dark ? "text-slate-400" : "text-slate-500";
  const faint = dark ? "text-slate-500" : "text-slate-400";
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold truncate min-w-0 ${muted}`}>
          <MapPin className="w-3 h-3 shrink-0" /> <span className="truncate">{loc.name}</span>
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={onToggleUnit}
            title="Switch units"
            className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"}`}
          >
            °{unitF ? "F" : "C"}
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label="Manage locations"
            title="Manage locations"
            className={`p-1 rounded ${dark ? "text-slate-500 hover:text-slate-300" : "text-slate-400 hover:text-slate-600"}`}
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!data ? (
        <p className={`text-xs ${muted}`}>{err ? "Weather unavailable." : "Loading…"}</p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Icon className="w-12 h-12 shrink-0" style={{ color: "var(--color-accent)" }} />
            <div className="min-w-0">
              <span className={`block text-4xl font-bold tabular-nums leading-none ${dark ? "text-slate-100" : "text-slate-800"}`}>
                {Math.round(cur.temperature_2m)}°
              </span>
              <span className={`block text-xs mt-1 truncate ${muted}`}>{info.label}</span>
            </div>
          </div>
          <div className={`text-[11px] ${faint}`}>
            Feels {Math.round(cur.apparent_temperature)}° · Wind {Math.round(cur.wind_speed_10m)} {unitF ? "mph" : "km/h"}
          </div>
          {daily?.time?.length > 1 && (
            <div className="flex items-stretch gap-1.5 pt-0.5">
              {daily.time.slice(1, 4).map((t, i) => {
                const di = weatherInfo(daily.weather_code[i + 1], 1);
                const DIcon = WEATHER_ICONS[di.kind] || Cloud;
                const day = new Date(`${t}T00:00`).toLocaleDateString([], { weekday: "short" });
                return (
                  <div key={t} className={`flex-1 flex flex-col items-center gap-1 rounded-lg py-2 ${dark ? "bg-white/5" : "bg-slate-100"}`}>
                    <span className={`text-[10px] ${faint}`}>{day}</span>
                    <DIcon className={`w-5 h-5 ${muted}`} />
                    <span className={`text-[11px] tabular-nums ${dark ? "text-slate-300" : "text-slate-600"}`}>
                      {Math.round(daily.temperature_2m_max[i + 1])}°<span className={faint}> {Math.round(daily.temperature_2m_min[i + 1])}°</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// A compact card for a secondary location, shown under the hero. Clicking it
// promotes that city to primary (swaps it into the featured slot).
function WeatherMini({ loc, data, dark, onClick }) {
  const cur = data?.current;
  const info = cur ? weatherInfo(cur.weather_code, cur.is_day) : null;
  const Icon = info ? (WEATHER_ICONS[info.kind] || Cloud) : Cloud;
  const daily = data?.daily;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Feature ${loc.name}`}
      className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
        dark ? "bg-white/5 hover:bg-white/10" : "bg-slate-100 hover:bg-slate-200/70"
      }`}
    >
      <Icon className="w-7 h-7 shrink-0" style={{ color: "var(--color-accent)" }} />
      <div className="min-w-0 flex-1">
        <div className={`text-[11px] truncate ${dark ? "text-slate-400" : "text-slate-500"}`}>{loc.name}</div>
        <div className="flex items-baseline gap-1.5">
          <span className={`text-xl font-bold tabular-nums leading-none ${dark ? "text-slate-100" : "text-slate-800"}`}>
            {cur ? Math.round(cur.temperature_2m) : "—"}°
          </span>
          <span className={`text-[11px] truncate ${dark ? "text-slate-500" : "text-slate-400"}`}>{info?.label || ""}</span>
        </div>
      </div>
      {daily && (
        <div className={`text-[11px] tabular-nums shrink-0 ${dark ? "text-slate-400" : "text-slate-500"}`}>
          {Math.round(daily.temperature_2m_max[0])}°<span className={dark ? "text-slate-600" : "text-slate-400"}> {Math.round(daily.temperature_2m_min[0])}°</span>
        </div>
      )}
    </button>
  );
}

// Manage mode — reorder (star = make primary), remove, add cities, pick units.
function WeatherManager({ dark, locations, unit, onAdd, onRemove, onMakePrimary, onSetUnit, onDone }) {
  const muted = dark ? "text-slate-400" : "text-slate-500";
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${muted}`}>Locations</span>
        <button type="button" onClick={onDone} className="text-[11px] font-semibold text-[var(--color-accent)] hover:underline">Done</button>
      </div>

      {locations.length > 0 && (
        <ul className="space-y-1">
          {locations.map((l, i) => (
            <li key={locKey(l)} className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1 ${dark ? "bg-white/5" : "bg-slate-100"}`}>
              <button
                type="button"
                onClick={() => onMakePrimary(i)}
                disabled={i === 0}
                title={i === 0 ? "Primary location" : "Make primary"}
                className={`p-1 rounded shrink-0 ${
                  i === 0 ? "text-amber-400" : dark ? "text-slate-500 hover:text-amber-400" : "text-slate-400 hover:text-amber-500"
                }`}
              >
                <Star className="w-3.5 h-3.5" fill={i === 0 ? "currentColor" : "none"} />
              </button>
              <span className={`flex-1 min-w-0 truncate text-[12px] ${dark ? "text-slate-200" : "text-slate-700"}`}>{l.name || "—"}</span>
              {i === 0 && <span className={`text-[9px] font-bold uppercase tracking-wide shrink-0 ${muted}`}>Primary</span>}
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label="Remove location"
                title="Remove"
                className={`p-1 rounded shrink-0 ${dark ? "text-slate-500 hover:text-rose-400" : "text-slate-400 hover:text-rose-500"}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <p className={`text-[10px] font-bold uppercase tracking-wider mb-1 ${dark ? "text-slate-500" : "text-slate-400"}`}>Add a location</p>
        <CityPicker dark={dark} onPick={onAdd} />
      </div>

      <div className={`flex items-center justify-between pt-1.5 border-t ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
        <span className={`text-[11px] ${muted}`}>Units</span>
        <div className="flex items-center gap-1">
          {["fahrenheit", "celsius"].map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => onSetUnit(u)}
              className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                unit === u ? "text-white bg-[var(--color-accent)]" : dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              °{u === "fahrenheit" ? "F" : "C"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Current conditions for one or many cities. The first (primary) is featured big;
// any others show as compact cards under it — click one to feature it. Themed for
// the app (light/dark), unlike the kiosk's white-on-dark panel. Manage the list
// (add/remove/reorder cities + °F/°C) from the gear.
export default function WeatherWidget({ dark, bare = false }) {
  const { wx, err, locations, unit, hasPlace, addPlace, removePlace, makePrimary, setUnit } = useWeather();
  const [editing, setEditing] = useState(false);
  const unitF = unit === "fahrenheit";

  const body = (
    <div className="space-y-3">
      {!hasPlace ? (
        <div className="space-y-2">
          <p className={`text-[11px] ${dark ? "text-slate-500" : "text-slate-500"}`}>Add a city to see local weather.</p>
          <CityPicker dark={dark} onPick={addPlace} />
        </div>
      ) : editing ? (
        <WeatherManager
          dark={dark}
          locations={locations}
          unit={unit}
          onAdd={addPlace}
          onRemove={removePlace}
          onMakePrimary={makePrimary}
          onSetUnit={setUnit}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <WeatherHero
            loc={locations[0]}
            data={wx[locKey(locations[0])]}
            unitF={unitF}
            err={err}
            dark={dark}
            onToggleUnit={() => setUnit(unitF ? "celsius" : "fahrenheit")}
            onEdit={() => setEditing(true)}
          />
          {locations.length > 1 && (
            <div className="space-y-1.5">
              {locations.slice(1).map((l, i) => (
                <WeatherMini key={locKey(l)} loc={l} data={wx[locKey(l)]} dark={dark} onClick={() => makePrimary(i + 1)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );

  if (bare) return <div className="h-full overflow-y-auto p-3">{body}</div>;
  return (
    <WidgetSection id="weather" icon={Cloud} title="Weather" dark={dark}>
      {body}
    </WidgetSection>
  );
}
