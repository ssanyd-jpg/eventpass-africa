"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSeasonPassAction } from "./actions";

export default function SeasonPassForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [maxHolders, setMaxHolders] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createSeasonPassAction({
        name,
        description,
        price: Math.round(Number(price) * 100),
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        maxHolders: maxHolders.trim() === "" ? null : Math.round(Number(maxHolders)),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`"${name}" created as a draft — publish it below to start selling.`);
      setName("");
      setDescription("");
      setPrice("");
      setStartDate("");
      setEndDate("");
      setMaxHolders("");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5">
      <h2 className="font-semibold">Create a season pass</h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="sp-name">Name</label>
          <input
            id="sp-name"
            required
            className="input"
            placeholder="Simba SC 2026/27 Season"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="sp-price">Price (TZS)</label>
          <input
            id="sp-price"
            type="number"
            min={1}
            step="0.01"
            required
            className="input"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="sp-description">Description</label>
        <input
          id="sp-description"
          className="input"
          placeholder="Valid for every home match this season"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="sp-start">Season starts</label>
          <input id="sp-start" type="date" required className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="sp-end">Season ends</label>
          <input id="sp-end" type="date" required className="input" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="sp-max">Max holders</label>
          <input
            id="sp-max"
            type="number"
            min={1}
            className="input"
            placeholder="Unlimited"
            value={maxHolders}
            onChange={(e) => setMaxHolders(e.target.value)}
          />
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {notice && <p className="text-sm text-ok">{notice}</p>}
      <button type="submit" disabled={submitting} className="btn-primary">
        {submitting ? "Creating…" : "Create season pass"}
      </button>
    </form>
  );
}
