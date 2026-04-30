/**
 * Position state — stored in localStorage, read by client components when
 * stamping observation/case writes.
 *
 * Storage key: `even_elo_position`. Value: full position name string
 * (e.g., "Customer Care Lead").
 *
 * Server components / API routes never read localStorage; they accept the
 * position via request body or query param.
 */

export const STORAGE_KEY = "even_elo_position";

/** Hardcoded seed positions — must match migration 003_seed_positions. */
export interface PositionSeed {
  name: string;
  team: string;
  description: string;
}

export const POSITION_SEEDS: PositionSeed[] = [
  { name: "OT Coordinator",          team: "OT",         description: "Creates cases · OT discipline + return-to-OT" },
  { name: "Anesthesia Coordinator",  team: "Anesthesia", description: "PAC completion" },
  { name: "Medical Superintendent",  team: "MS",         description: "Mortality, readmission, discharge summary, rounds" },
  { name: "ICN Lead",                team: "ICN",        description: "Surgical site infections" },
  { name: "Clinical Pharmacologist", team: "Pharmacy",   description: "Antibiotic stewardship" },
  { name: "Customer Care Lead",      team: "CC",         description: "NPS, complaints, family communication" },
  { name: "Billing Lead",            team: "Billing",    description: "Insurance denials" },
  { name: "Unit Head",               team: "UnitHead",   description: "Anomaly flags, behavioural patterns" },
  { name: "Committee Admin",         team: "Admin",      description: "Roster, weights, stream config" },
];

export function getCurrentPosition(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export const POSITION_CHANGE_EVENT = "even-elo-position-changed";

export function setCurrentPosition(name: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, name);
  window.dispatchEvent(new CustomEvent(POSITION_CHANGE_EVENT, { detail: name }));
}

export function clearCurrentPosition(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(POSITION_CHANGE_EVENT, { detail: null }));
}

/**
 * React hook helper — subscribe to position changes across the app.
 * Listens to both same-tab CustomEvents (PositionChip dispatch) and
 * cross-tab `storage` events.
 */
export function onPositionChange(handler: (name: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (e: Event) => handler(((e as CustomEvent).detail ?? null) as string | null);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) handler(e.newValue);
  };
  window.addEventListener(POSITION_CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(POSITION_CHANGE_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
