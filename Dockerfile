# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Solo dependencias primero para cachear
COPY package*.json ./
RUN npm ci || npm install

# Copia el resto del código
COPY . .

# Compila TS
RUN npm run build

EXPOSE 8080
CMD ["node", "dist/index.js"]