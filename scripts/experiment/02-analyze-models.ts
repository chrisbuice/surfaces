/**
 * 02-analyze-models.ts
 *
 * Submits songs through a lyric analysis prompt to one of three models.
 * Uses batch APIs for cost efficiency.
 *
 * Usage:
 *   npx tsx 02-analyze-models.ts --model=sonnet-4-6 --input=golden-set-with-lyrics.json
 *   npx tsx 02-analyze-models.ts --model=gpt-5 --input=golden-set-with-lyrics.json
 *   npx tsx 02-analyze-models.ts --model=gpt-5-5 --input=golden-set-with-lyrics.json
 *
 * Models:
 *   sonnet-4-6  → Anthropic Message Batches API (claude-sonnet-4-6)
 *   gpt-5       → OpenAI Batch API (gpt-5, structured output)
 *   gpt-5-5     → OpenAI Batch API (gpt-5.5, structured output)
 *
 * Requires: ANTHROPIC_API_KEY (for sonnet), OPENAI_API_KEY (for gpt-*)
 *
 * Output: analyses-{model}.jsonl in the experiment directory
 */

// TODO: implement
// 1. Parse --model and --input flags
// 2. Read input JSON (golden-set-with-lyrics.json or full candidates)
// 3. Load prompt from prompts/lyric-analysis-v1.md
// 4. For Anthropic: submit Message Batch, poll for completion
// 5. For OpenAI: create batch with structured output schema, poll
// 6. Parse results, validate JSON schema
// 7. Write to analyses-{model}.jsonl

export {};
