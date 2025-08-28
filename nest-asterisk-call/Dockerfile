# Etapa de build
FROM node:20 AS build

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

# Etapa de producción
FROM node:20

WORKDIR /app

# Copia el código compilado y los node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./

ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "dist/main"]
