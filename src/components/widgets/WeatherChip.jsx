import { Cloud } from "lucide-react";
import { weatherInfo } from "../../lib/weather";
import WeatherWidget, { useWeather, WEATHER_ICONS } from "../office/WeatherWidget";
import WidgetChip from "./WidgetChip";

// Pinned-strip chip for weather: the PRIMARY location's condition icon + temp in
// the pill, the full weather card (all locations + city manager) in the popover.
// Shares the config with the card via useWeather.
export default function WeatherChip({ dark }) {
  const { primary, primaryData, hasPlace } = useWeather();
  const cur = primaryData?.current;
  const info = cur ? weatherInfo(cur.weather_code, cur.is_day) : null;
  const Icon = info ? (WEATHER_ICONS[info.kind] || Cloud) : Cloud;

  return (
    <WidgetChip
      icon={Icon}
      name={hasPlace ? undefined : "Weather"}
      value={cur ? `${Math.round(cur.temperature_2m)}°` : (hasPlace ? "…" : null)}
      title={hasPlace ? `${primary.name}${info ? ` · ${info.label}` : ""}` : "Set your weather city"}
      dark={dark}
    >
      <WeatherWidget dark={dark} />
    </WidgetChip>
  );
}
