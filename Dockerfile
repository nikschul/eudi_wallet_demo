FROM node:24-alpine AS verified
WORKDIR /app
RUN apk add --no-cache bash
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts ./scripts
COPY server ./server
COPY public ./public
COPY test ./test
RUN npm run check && npm test

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=verified --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=verified --chown=node:node /app/node_modules ./node_modules
COPY --from=verified --chown=node:node /app/server ./server
COPY --from=verified --chown=node:node /app/public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
