FROM node:16.13-bullseye-slim as build

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production \
  && cp -R node_modules prod_node_modules \
  && npm install
COPY . .
RUN npm run build

FROM node:16.13-bullseye-slim as release

RUN apt-get update && apt-get install -y bash curl postgresql-client

WORKDIR /usr/src/app
RUN mkdir -p data/products

RUN addgroup --gid 1001 --system infracost && \
  adduser --uid 1001 --system --ingroup infracost infracost && \
  chown -R infracost:infracost /usr/src/app
USER 1001

COPY --from=build /usr/src/app/prod_node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY package*.json ./
ENV NODE_ENV=production
EXPOSE 4000
CMD [ "npm", "run", "start" ]
