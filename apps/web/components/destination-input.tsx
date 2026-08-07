"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { StationOption } from "./station-input";

export type DestinationValue =
  | { kind: "station"; crs: string; name: string }
  | { kind: "postcode"; text: string };

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

/**
 * Destination picker: station name/CRS (same ranking/typeahead as
 * StationInput) plus a "Search postcode" row when the typed text also looks
 * postcode-shaped. Selecting the postcode row defers actual geocoding to
 * submit time — no lookup happens per keystroke.
 */
export function DestinationInput({ label, name, value, onChange, placeholder }: Props) {
  const id = useId();
  const initialQuery = value ? (value.kind === "station" ? value.name : value.text) : "";
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<StationOption[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRemote([]);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/stations?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then((data: StationOption[]) => setRemote(Array.isArray(data) ? data : []))
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query]);

  const showPostcodeOption = looksLikePostcode(query);
  const stationOptions = remote.slice(0, showPostcodeOption ? 6 : 8);
  // Postcode row is always last, so arrow-key/active-index math stays simple.
  const optionCount = stationOptions.length + (showPostcodeOption ? 1 : 0);

  useEffect(() => {
    setQuery(value ? (value.kind === "station" ? value.name : value.text) : "");
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

  function selectByIndex(i: number) {
    if (i < stationOptions.length) selectStation(stationOptions[i]!);
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
          {showPostcodeOption && (
            <li
              id={`${id}-opt-${stationOptions.length}`}
              role="option"
              aria-selected={active === stationOptions.length}
              className="combo-option combo-option-postcode"
              onMouseEnter={() => setActive(stationOptions.length)}
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
