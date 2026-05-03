# Lyric Analysis Prompt — v1 (DRAFT)

Status: DRAFT — iterate in Stage 0 until 5 obsession songs pass quality check.

---

## System Prompt

```
You are a music analyst. Given song lyrics, produce a structured JSON analysis. Be specific — reference concrete images, phrases, and narrative details from the actual text. Never produce generic descriptions that could apply to multiple songs.

Rules:
- subject_paragraph: 2–4 sentences describing WHAT HAPPENS in the song. Name specific imagery, settings, actions from the lyrics. If someone read only this paragraph, they should be able to identify which song it's about.
- subject_tags: 3–6 short noun phrases capturing the concrete subjects (not vibes — objects, settings, relationships, actions).
- tones: 2–5 tone labels. These describe the EMOTIONAL TEXTURE of the delivery, not the topic. A sad song delivered with dark humor should include both.
- listener_feel_generic: How a typical attentive listener feels while hearing this song. Not what the song is "about" — what it DOES to the listener.
- narrative fields: POV, who it's addressed to, time orientation, one-sentence arc, narrator reliability.
- vocal_delivery_inferred: What you can infer about vocal delivery from lyric structure alone (repetition patterns, exclamations, whispered asides, call-and-response, etc.)
- vocab_level: Based on actual word choices in the lyrics.
- Do NOT hallucinate details not present in the lyrics.
- Do NOT describe the song's cultural reception or artist biography.
- Language detection: tag the actual language of the lyrics.
```

## User Message Template

```
Analyze these lyrics. Return ONLY valid JSON matching the schema below.

Track: {track_name}
Artist: {artist_name}

Lyrics:
---
{lyrics_plain}
---
```

## Output JSON Schema

```json
{
  "subject_paragraph": "string (2-4 sentences, specific to THIS song)",
  "subject_tags": ["string", "..."],  // 3-6 noun phrases
  "tones": ["string", "..."],  // 2-5 tone labels
  "listener_feel_generic": {
    "valence": "number (-1 to 1, negative=unpleasant, positive=pleasant)",
    "arousal": "number (-1 to 1, low=calm, high=energized)",
    "dominance": "number (-1 to 1, low=submissive/vulnerable, high=empowered)",
    "primary_emotion": "string",
    "secondary_emotions": ["string", "..."],
    "intensity": "number (0-1)",
    "ambivalence": "number (0-1, how much the song pulls in opposing emotional directions)"
  },
  "narrative_pov": "first | second | third | mixed",
  "addressed_to": "lover | self | friend | family | god | crowd | enemy | abstract | none",
  "time_frame": "present | retrospective | prospective | timeless",
  "story_arc": "string (one sentence)",
  "narrator_reliability": "straight | ironic | unreliable | persona",
  "vocal_delivery_inferred": ["string", "..."],
  "tempo_feel": "dragging | slow | mid | driving | frantic",
  "energy_curve": "string (e.g. 'builds steadily', 'flat intensity', 'peaks then resolves')",
  "dynamic_range": "flat | moderate | wide",
  "vocab_level": "simple | colloquial | literary | arcane",
  "slang_era": ["string", "..."],
  "references": {
    "people": ["string"],
    "places": ["string"],
    "brands": ["string"],
    "works": ["string"]
  },
  "explicitness": "number (0-1)",
  "content_flags": ["string"],
  "quotability": "number (0-10, how many individual lines are memorable standalone)",
  "rhyme_scheme": "string (e.g. 'ABAB', 'free verse', 'internal rhyme dominant')",
  "repetition_density": "number (0-1, fraction of lyrics that are repeated phrases/choruses)",
  "chorus_verse_balance": "number (0-1, 0=all verse, 1=all chorus)",
  "has_bridge": "boolean",
  "structure_signature": "string (e.g. 'verse-chorus-verse-chorus-bridge-chorus')",
  "language": "string (BCP-47, e.g. 'en')"
}
```

---

## Stage 0 Iteration Notes

Use this section to track prompt revisions during interactive iteration.

### Iteration seeds (5 songs to test against):

Pick from obsession seeds — songs where you have strong opinions about what the analysis SHOULD say:

1. **Tyler Childers - Shake the Frost (Live)** — should capture: Appalachian imagery, drinking/partying, defiant joy, the specific "shake the frost" metaphor
2. **Beyoncé - Ring Off** — should capture: mother's divorce narrative, celebration of liberation, specific references to her parents
3. **Miranda Lambert - Bathroom Sink** — should capture: domestic confession, mirror-as-witness, morning routine, raw honesty
4. **M.I.A. - Borders** — should capture: immigration/displacement, political challenge, repetitive interrogation structure
5. **Noah Kahan - Stick Season** — should capture: New England autumn, relationship ending, self-aware bitterness, specific place imagery

### What to check in each iteration:
- [ ] subject_paragraph: Would someone identify the song from this alone?
- [ ] tones: Do they match YOUR experience of the song (not a generic reading)?
- [ ] listener_feel_generic.primary_emotion: Gut-check — is this what the song makes YOU feel?
- [ ] subject_tags: Are they concrete nouns/actions, not vibes?
- [ ] References: Did it catch specific people/places named in lyrics?
- [ ] Vocal delivery inferred: Does it notice structural features (repetition, spoken word, call-and-response)?

### Known failure modes to watch for:
- Generic "love and loss" descriptions on songs with rich specific imagery
- Confusing what the song is ABOUT with how it makes you FEEL
- Over-reading simple party songs (not everything has deep meaning)
- Missing irony/humor (reading Da Baddest Bitch as sincere bragging vs. playful confidence)
- Hallucinating details not in the actual lyrics text
