FROM node:22-alpine

RUN npm install -g tsx@4

WORKDIR /app

# Copy shared source modules (preserves repo-relative paths for imports)
COPY src/lyrics/lrclib.ts src/lyrics/
COPY src/credits/musicbrainz.ts src/credits/

# Copy container code
COPY stack/lyrics-backfill/lib/ stack/lyrics-backfill/lib/
COPY stack/lyrics-backfill/main.ts stack/lyrics-backfill/phase-isrc.ts \
     stack/lyrics-backfill/phase-lyrics.ts stack/lyrics-backfill/phase-credits.ts \
     stack/lyrics-backfill/

WORKDIR /app/stack/lyrics-backfill

ENTRYPOINT ["tsx", "main.ts"]
