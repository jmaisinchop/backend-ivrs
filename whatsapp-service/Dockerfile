    # --- Etapa 1: Build ---
    FROM node:20-alpine AS build
    # Instala git y datos de zona horaria
    RUN apk add --no-cache git tzdata

    WORKDIR /app
    COPY package*.json ./
    RUN npm install --legacy-peer-deps
    COPY . .
    RUN npm run build

    # --- Etapa 2: Producción ---
    FROM node:20-alpine
    # Instala datos de zona horaria en la imagen final
    RUN apk add --no-cache tzdata

    WORKDIR /app
    COPY --from=build /app/dist ./dist
    COPY --from=build /app/package*.json ./
    RUN npm install --production --legacy-peer-deps

    # Para nest-api usa 3000, para whatsapp-service usa 3001
    EXPOSE 3001

    CMD ["node", "dist/main"]
    
