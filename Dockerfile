FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV DB_PATH=/data/waybill.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
