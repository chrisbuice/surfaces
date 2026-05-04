/**
 * prompt.ts — System prompt and JSON schema for Sonnet lyric analysis.
 *
 * The system prompt is identical across all songs (Anthropic prompt caching
 * gives us a near-free cache hit on every call after the first).
 */

export const ANALYSIS_VERSION = "1.0.0";
export const MODEL_ID = "claude-sonnet-4-6";

export const SYSTEM_PROMPT = `You are a music analyst. Given a song's lyrics, track name, and artist name, produce a structured JSON analysis. Be specific — reference concrete imagery, phrases, and narrative details from the lyrics. Avoid generic descriptions like "love and loss" when the lyric has specific details you can name.

Output valid JSON matching the schema below. No markdown, no commentary, just the JSON object.

JSON Schema:
{
  "subject_paragraph": "string — 2-4 sentences describing: who is the narrator, what is happening, what is the setting, what is the emotional arc or resolution. Be concrete.",
  "subject_tags": ["string — 3-6 short noun phrases capturing the core subjects. e.g. 'road trip nostalgia', 'toxic relationship', 'childhood home'. Not genre labels."],
  "listener_feel_generic": {
    "valence": "number — -1.0 (deeply negative) to 1.0 (euphoric). 0 is neutral.",
    "arousal": "number — 0.0 (lullaby calm) to 1.0 (adrenaline rush).",
    "dominance": "number — 0.0 (helpless/small) to 1.0 (powerful/commanding).",
    "primary_emotion": "string — single word: joy, sadness, anger, fear, surprise, disgust, nostalgia, longing, defiance, tenderness, euphoria, melancholy, anxiety, serenity, bitterness, hope, resignation, pride, shame, awe, lust, grief, playfulness, contempt",
    "secondary_emotions": ["string — 1-3 additional emotions present"],
    "intensity": "number — 0.0 (barely there) to 1.0 (overwhelming).",
    "ambivalence": "number — 0.0 (emotionally clear) to 1.0 (deeply conflicted)."
  },
  "tones": ["string — 2-5 tone labels describing the song's feel. e.g. 'wistful', 'defiant', 'sardonic', 'intimate', 'anthemic'. These describe how the song feels, not what it's about."],
  "language": "string — BCP-47 code, e.g. 'en', 'es', 'fr'. Use 'unknown' if genuinely ambiguous.",
  "narrative_pov": "string — 'first' | 'second' | 'third' | 'mixed'",
  "addressed_to": "string — 'lover' | 'self' | 'friend' | 'family' | 'god' | 'crowd' | 'enemy' | 'abstract' | 'none'",
  "time_frame": "string — 'present' | 'retrospective' | 'prospective' | 'timeless'",
  "story_arc": "string — one sentence describing the narrative trajectory, e.g. 'starts in denial, moves through confrontation, ends in acceptance'",
  "narrator_reliability": "string — 'straight' | 'ironic' | 'unreliable' | 'persona'",
  "vocal_delivery_inferred": ["string — 1-3 inferred vocal qualities from lyric cues. e.g. 'belted chorus', 'spoken-word bridge', 'whispered verses', 'call-and-response'. Infer from structure and content, not from hearing the track."],
  "tempo_feel": "string — 'dragging' | 'slow' | 'mid' | 'driving' | 'frantic'. Infer from lyric pacing and structure.",
  "energy_curve": "string — one sentence describing how energy changes across the song. e.g. 'builds steadily from quiet verse to explosive final chorus'",
  "dynamic_range": "string — 'flat' | 'moderate' | 'wide'",
  "vocab_level": "string — 'simple' | 'colloquial' | 'literary' | 'arcane'",
  "slang_era": ["string — 0-3 era/region labels for slang used. e.g. '2010s internet', 'Southern US', '90s hip-hop'. Empty array if no notable slang."],
  "references_json": {
    "people": ["string — named people referenced"],
    "places": ["string — named places referenced"],
    "brands": ["string — named brands/products referenced"],
    "works": ["string — other songs/films/books referenced"]
  },
  "explicitness": "number — 0.0 (clean) to 1.0 (very explicit). Based on sexual content, violence, profanity.",
  "content_flags": ["string — 0-5 flags. Options: 'profanity', 'sexual', 'violence', 'substance_use', 'self_harm', 'political'. Empty array if none."],
  "quotability": "integer — 0-10. How many memorable/quotable standalone lines the song has.",
  "rhyme_scheme": "string — dominant pattern, e.g. 'AABB', 'ABAB', 'free verse', 'internal rhyme heavy', 'mixed'",
  "repetition_density": "number — 0.0 (every line unique) to 1.0 (almost entirely repeated phrases/hooks).",
  "chorus_verse_balance": "number — 0.0 (all verse, no chorus) to 1.0 (all chorus/hook). 0.5 is balanced.",
  "line_length_variance": "number — 0.0 (all lines same length) to 1.0 (wildly varying). Captures rhythmic regularity.",
  "has_bridge": "boolean — true if the song has a bridge section (distinct from verse/chorus).",
  "structure_signature": "string — e.g. 'verse-chorus-verse-chorus-bridge-chorus', 'ABABCB', 'through-composed'",
  "lyric_intrusion": "number — 0.0 (easy to ignore, background-friendly) to 1.0 (demands active attention, pulls you out of whatever you're doing). Consider: narrative complexity, emotional intensity, conversational/directive address, specificity of imagery."
}`;

export function buildUserMessage(
  trackName: string,
  artistName: string,
  lyrics: string,
): string {
  return `Track: "${trackName}" by ${artistName}

Lyrics:
${lyrics}`;
}
