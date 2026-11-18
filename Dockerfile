FROM dhi.io/node:24-alpine3.23

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build Application 
RUN npm run typecheck \
    && npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

# Entrypoint 
COPY infra/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh 

# Exit Root

RUN addgroup -S appgroup \
    && adduser -S user -G appgroup \
    && chown -R user:appgroup /app

USER user

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["node", "dist/index.js"]