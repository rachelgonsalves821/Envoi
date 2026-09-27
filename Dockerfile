FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docs ./docs
COPY README.md ./README.md

ENV NODE_ENV=production
ENV SINALOA_HOST=0.0.0.0
ENV SINALOA_PORT=8787
ENV SINALOA_DATA_DIR=/app/data

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8787

CMD ["node", "src/server.js"]
