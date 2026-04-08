FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY bot.js ./

# Config and logs volume
VOLUME ["/config"]

CMD ["node", "bot.js"]
