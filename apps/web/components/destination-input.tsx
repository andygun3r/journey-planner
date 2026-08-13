"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { StationOption } from "./station-input";

export type DestinationValue =
  | { kind: "station"; crs: string; name: string }
  | { kind: "postcode"; text: string }
  | { kind: "place"; uprn: string; name: string };

/** A free-text place/address hit from OS Places (see lib/os-places.ts). */
export interface PlaceOption {
  id: string;
  label: string;
  shortLabel: string;
}

interface Props {
  label: string;
  name: string;
  value: DestinationValue | null;
  onChange: (value: DestinationValue | null) => void;
  placeholder?: string;
}

/** Loose UK postcode/outcode shape check, mirrored from lib/geocoding.ts (kept client-side to avoid importing a server module here). */
function looksLikePostcode(query: string): boolean {
  const q = query.trim().toUpperCase();
  return /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/.test(q) || /^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(q);
}

/** Text to show in the box for a chosen destination, whatever kind it is. */
function displayValue(value: DestinationValue | null): string {
  if (!value) return "";
  return value.kind === "postcode" ? value.text : value.name;
}

/**
 * Destination picker: station name/CRS (same ranking/typeahead as
 * StationInput), then free-text place/address results from OS Places, then a
 * "Search postcode" row when the typed text also looks postcode-shaped.
 *
 * Stations come first deliberately — this is a rail app, and a station must
 * never lose its position in the list to a similarly-named shop. Places only
 * appear when OS Places is configured; without a key the box behaves exactly
 * as it did before. Selecting the postcode row defers geocoding to submit
 * time, but a place row carries a UPRN that's resolved at plan time.
 */
export function DestinationInput({ label, name, value, onChange, placeholder }: Props) {
  const id = useId();
  const initialQuery = displayValue(value);
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<StationOption[]>([]);
  const [places, setPlaces] = useState<PlaceOption[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRemote([]);
      setPlaces([]);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/stations?q=${encodeURIComponent(q)}&places=1`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: StationOption[] | { stations: StationOption[]; places: PlaceOption[] } | null) => {
          // The route returns a bare array when place search is off, and an
          // object when it's on — accept both so the box keeps working either
          // way (and if OS Places is unconfigured, `places` is simply empty).
          if (Array.isArray(data)) {
            setRemote(data);
            setPlaces([]);
          } else if (data) {
            setRemote(Array.isArray(data.stations) ? data.stations : []);
            setPlaces(Array.isArray(data.places) ? data.places : []);
          }
        })
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query]);

  const showPostcodeOption = looksLikePostcode(query);
  const stationOptions = remote.slice(0, showPostcodeOption ? 6 : 8);
  // Places sit below stations (rail first) and above the postcode row, which
  // stays last so arrow-key/active-index math stays simple. Order here is the
  // single source of truth for selectByIndex and the rendered ids.
  const placeOptions = places.slice(0, 4);
  const placeOffset = stationOptions.length;
  const postcodeIndex = placeOffset + placeOptions.length;
  const optionCount = postcodeIndex + (showPostcodeOption ? 1 : 0);

  useEffect(() => {
    setQuery(displayValue(value));
  }, [value]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function selectStation(option: StationOption) {
    onChange({ kind: "station", crs: option.crs, name: option.name });
    setQuery(option.name);
    setOpen(false);
  }

  function selectPostcode() {
    const text = query.trim();
    onChange({ kind: "postcode", text });
    setOpen(false);
  }

  function selectPlace(option: PlaceOption) {
    onChange({ kind: "place", uprn: option.id, name: option.shortLabel });
    setQuery(option.shortLabel);
    setOpen(false);
  }

  function selectByIndex(i: number) {
    if (i < placeOffset) selectStation(stationOptions[i]!);
    else if (i < postcodeIndex) selectPlace(placeOptions[i - placeOffset]!);
    else selectPostcode();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, optionCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (open && optionCount > 0) {
        e.preventDefault();
        selectByIndex(active);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="field" ref={rootRef}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        role="combobox"
        aria-expanded={open && optionCount > 0}
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open && optionCount > 0 ? `${id}-opt-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
          if (value && e.target.value !== initialQuery) onChange(null);
        }}
        onFocus={() => query && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && optionCount > 0 && (
        <ul id={`${id}-listbox`} role="listbox" className="combo-list" aria-label={label}>
          {stationOptions.map((option, i) => (
            <li
              key={option.crs}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className="combo-option"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                selectStation(option);
              }}
            >
              <span>{option.name}</span>
              <span className="crs">{option.crs}</span>
            </li>
          ))}
          {placeOptions.map((option, i) => (
            <li
              key={option.id}
              id={`${id}-opt-${placeOffset + i}`}
              role="option"
              aria-selected={placeOffset + i === active}
              className="combo-option combo-option-place"
              onMouseEnter={() => setActive(placeOffset + i)}
              onMouseDown={(e) => {
                e.preventDefault();
                selectPlace(option);
              }}
            >
              <span>{option.shortLabel}</span>
              {/* "Place" rather than an icon alone — status and kind are never
                  conveyed by colour or glyph alone (PRODUCT.md, WCAG 2.2 AA). */}
              <span className="crs">Place</span>
            </li>
          ))}
          {showPostcodeOption && (
            <li
              id={`${id}-opt-${postcodeIndex}`}
              role="option"
              aria-selected={active === postcodeIndex}
              className="combo-option combo-option-postcode"
              onMouseEnter={() => setActive(postcodeIndex)}
              onMouseDown={(e) => {
                e.preventDefault();
                selectPostcode();
              }}
            >
              <span>📍 Search postcode &ldquo;{query.trim().toUpperCase()}&rdquo;</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
