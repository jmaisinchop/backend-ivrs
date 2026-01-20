# --- Etapa 1: Build ---
FROM node:20-slim AS build

# ✅ CORREGIDO: Usar apt-get para la imagen Debian Slim
# Necesitas actualizar, instalar y luego limpiar la caché en el mismo paso
RUN apt-get update && \
    apt-get install -y tzdata git && \
    rm -rf /var/lib/apt/lists/*

ENV TZ="America/Guayaquil"
WORKDIR /app
COPY package*.json ./
# Ahora este comando funcionará porque 'git' ya existe
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

# --- Etapa 2: Producción ---
FROM node:20-slim

# ✅ CORREGIDO: Usar apt-get para la imagen Debian Slim
RUN apt-get update && \
    apt-get install -y tzdata && \
    rm -rf /var/lib/apt/lists/*

ENV TZ="America/Guayaquil"
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
RUN npm install --production --legacy-peer-deps
EXPOSE 3001
CMD ["node", "dist/main"]