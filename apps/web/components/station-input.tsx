"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface StationOption {
  crs: string;
  name: string;
}

interface Props {
  label: string;
  name: string;
  stations: StationOption[];
  value: StationOption | null;
  onChange: (station: StationOption | null) => void;
  placeholder?: string;
}

function rank(stations: StationOption[], query: string): StationOption[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const exactCrs: StationOption[] = [];
  const prefix: StationOption[] = [];
  const word: StationOption[] = [];
  const contains: StationOption[] = [];
  for (const s of stations) {
    const name = s.name.toLowerCase();
    if (s.crs.toLowerCase() === q) exactCrs.push(s);
    else if (name.startsWith(q)) prefix.push(s);
    else if (name.includes(` ${q}`)) word.push(s);
    else if (name.includes(q)) contains.push(s);
    if (exactCrs.length + prefix.length + word.length + contains.length > 40) break;
  }
  return [...exactCrs, ...prefix, ...word, ...contains].slice(0, 8);
}

export function StationInput({ label, name, stations, value, onChange, placeholder }: Props) {
  const id = useId();
  const [query, setQuery] = useState(value?.name ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => rank(stations, query), [stations, query]);

  useEffect(() => {
    setQuery(value?.name ?? "");
  }, [value]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function select(option: StationOption) {
    onChange(option);
    setQuery(option.name);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (open && options[active]) {
        e.preventDefault();
        select(options[active]);
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
        aria-expanded={open && options.length > 0}
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open && options[active] ? `${id}-opt-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
          if (value && e.target.value !== value.name) onChange(null);
        }}
        onFocus={() => query && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && options.length > 0 && (
        <ul id={`${id}-listbox`} role="listbox" className="combo-list" aria-label={label}>
          {options.map((option, i) => (
            <li
              key={option.crs}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className="combo-option"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                select(option);
              }}
            >
              <span>{option.name}</span>
              <span className="crs">{option.crs}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
