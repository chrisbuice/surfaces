FROM node:22-alpine

RUN npm install -g tsx@4

WORKDIR /app

COPY lib/ lib/
COPY main.ts phase-isrc.ts phase-lyrics.ts phase-credits.ts ./

ENTRYPOINT ["tsx", "main.ts"]
