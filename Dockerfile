# Stage 1: build
FROM node:16.13-alpine3.12 as build

WORKDIR /usr/src/app

# Copy manifest
COPY package*.json ./

# === STUB OUT MISSING LOGGER PACKAGE ===
RUN mkdir -p node_modules/@console/console-platform-log4js-utils \
    && printf '{ "name": "@console/console-platform-log4js-utils", "version": "4.1.0" }' \
       > node_modules/@console/console-platform-log4js-utils/package.json \
    && printf 'module.exports = { getLogger: () => console };' \
       > node_modules/@console/console-platform-log4js-utils/index.js

# Install dependencies (production + dev)
RUN npm install --production \
  && cp -R node_modules prod_node_modules \
  && npm install

# Copy source & build
COPY . .
RUN npm run build

# Stage 2: release
FROM node:16.13-alpine3.12 as release

RUN apk add --no-cache bash curl postgresql-client

WORKDIR /usr/src/app
RUN mkdir -p data/products

RUN addgroup -g 1001 -S infracost \
  && adduser -u 1001 -S infracost -G infracost \
  && chown -R infracost:infracost /usr/src/app
USER 1001

COPY --from=build /usr/src/app/prod_node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY package*.json ./

ENV NODE_ENV=production
EXPOSE 4000

CMD [ "npm", "run", "start" ]