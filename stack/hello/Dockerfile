FROM node:22-alpine

RUN npm install -g tsx@4

WORKDIR /app
COPY hello.ts .

ENTRYPOINT ["tsx", "hello.ts"]
