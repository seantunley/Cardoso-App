import { useState } from "react";
import { useSearchParams } from "react-router-dom";

// Initialise a tab state from a URL query param so deep-links (e.g. an Insights
// card) can land on a specific tab. The param is read once at mount and
// validated against `allowed`; an absent or unknown value falls back to
// `fallback`.
//
// Read-once is deliberate: after the user has landed, their manual tab clicks
// own the state and must not be yanked back by a now-stale URL. Returns the
// same [tab, setTab] tuple as useState, so it's a drop-in replacement.
export function useUrlTab(param, allowed, fallback) {
  const [searchParams] = useSearchParams();
  const requested = searchParams.get(param);
  return useState(allowed.includes(requested) ? requested : fallback);
}
