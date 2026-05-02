/**
 * labels.ts — labeled-8 computation.
 *
 * Eight artists are labeled by name in the constellation (spec §5.8):
 *   - 6 chosen algorithmically by composite score
 *     `total_plays × (years_active / total_years_in_data)`
 *     This surfaces artists who are *both* high-play and long-loyalty;
 *     two-week binges get demoted, long companions get promoted.
 *   - 2 chosen manually from manual_labels.ts (see §5.8 reasoning).
 *
 * Manual entries that don't resolve to a constellation node (because
 * the artist has <10 plays, or the spotify ID didn't resolve in the
 * node-build join) are silently skipped and logged. If the manual
 * list yields fewer than 2 valid picks, the algorithmic side fills
 * the remainder.
 */

import type { NodeRow } from "./types";
import { MANUAL_LABEL_ARTIST_IDS } from "./manual_labels";

export const LABEL_TOTAL = 8;
export const LABEL_MANUAL_TARGET = 2;

export function selectLabeledEight(nodes: NodeRow[]): Set<string> {
  if (nodes.length === 0) return new Set();

  // Total years in the data — same denominator used elsewhere.
  const peakYears = nodes.map(n => n.peak_year);
  const totalYears = Math.max(1, Math.max(...peakYears) - Math.min(...peakYears) + 1);

  // Composite score: plays × (years_active / total_years).
  const scored = nodes.map(n => ({
    name: n.artist_name,
    score: n.total_plays * (n.years_active / totalYears),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Phase 1 — manual picks that resolve. Only nodes with a unique
  // ("resolved") artist id can be matched; ambiguous and unresolved
  // nodes can't be unambiguously identified by URI.
  const manualSet = new Set<string>();
  const idToName = new Map<string, string>();
  for (const n of nodes) {
    if (n.artist_id.kind === "resolved") {
      idToName.set(`spotify:artist:${n.artist_id.id}`, n.artist_name);
    }
  }
  for (const uri of MANUAL_LABEL_ARTIST_IDS) {
    const name = idToName.get(uri);
    if (name) {
      manualSet.add(name);
    } else {
      console.warn(`constellation: manual label ${uri} did not resolve to a constellation node — skipped`);
    }
    if (manualSet.size >= LABEL_MANUAL_TARGET) break;
  }

  // Phase 2 — fill remaining slots with the top-scored artists,
  // skipping any already in the manual set.
  const labeled = new Set(manualSet);
  for (const s of scored) {
    if (labeled.size >= LABEL_TOTAL) break;
    if (!labeled.has(s.name)) labeled.add(s.name);
  }

  return labeled;
}
