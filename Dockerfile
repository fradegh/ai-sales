FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 5000

CMD ["sh", "-c", "echo 'Running migrations...' && npx drizzle-kit migrate && echo 'Migrations done. Starting app...' && npm run start"]
