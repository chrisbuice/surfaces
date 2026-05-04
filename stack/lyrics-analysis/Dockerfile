FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY lib/ lib/
COPY main.ts phase-analyze.ts phase-embed.ts prompt.ts ./
COPY blind-ratings.csv* ./

ENTRYPOINT ["npx", "tsx", "main.ts"]
