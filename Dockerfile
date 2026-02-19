FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 5000

COPY start.sh ./
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

CMD ["./start.sh"]
