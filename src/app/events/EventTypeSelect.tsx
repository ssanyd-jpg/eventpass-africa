"use client";

import { useState } from "react";

// The /events "Event type" filter. It only exists as a client component so the
// closed select can carry a `title` that follows the current selection: a
// native <select> ellipsis-truncates a long label ("Marathon / running race")
// in a narrow grid column, and the tooltip is how the full text stays
// discoverable without opening the list. Value handling is unchanged — still
// an uncontrolled select seeded from defaultValue, submitted by the GET form.
export default function EventTypeSelect({
  id,
  name,
  options,
  defaultValue,
}: {
  id: string;
  name: string;
  options: { value: string; label: string }[];
  defaultValue: string;
}) {
  const labelFor = (value: string) => options.find((o) => o.value === value)?.label ?? "";
  const [label, setLabel] = useState(() => labelFor(defaultValue));

  return (
    <select
      id={id}
      name={name}
      defaultValue={defaultValue}
      onChange={(e) => setLabel(labelFor(e.target.value))}
      title={label}
      className="input truncate"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
