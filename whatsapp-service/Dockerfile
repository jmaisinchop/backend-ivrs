# --- Etapa 1: Build ---
FROM node:20-alpine AS build

# ✅ AÑADIR: Instala tzdata Y TAMBIÉN git
RUN apk add --no-cache tzdata git

ENV TZ="America/Guayaquil"
WORKDIR /app
COPY package*.json ./
# Ahora este comando funcionará porque 'git' ya existe
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

# --- Etapa 2: Producción ---
# No se necesita git aquí, así que la imagen final se mantiene ligera
FROM node:20-alpine
RUN apk add --no-cache tzdata
ENV TZ="America/Guayaquil"
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
RUN npm install --production --legacy-peer-deps
EXPOSE 3001
CMD ["node", "dist/main"]