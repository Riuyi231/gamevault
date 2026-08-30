FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY index.js ./

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "index.js"]