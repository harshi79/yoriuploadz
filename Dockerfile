FROM node:22-alpine AS check
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server.js ./
COPY public ./public
COPY tests ./tests
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http=require('node:http');const r=http.get({host:'127.0.0.1',port:process.env.PORT||10000,path:'/health'},res=>process.exit(res.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.setTimeout(2000,()=>process.exit(1))"
CMD ["node", "server.js"]
