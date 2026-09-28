FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY backend ./backend
ENV NODE_ENV=production STORAGE_DIR=/app/uploads
EXPOSE 4000
CMD ["npm", "start"]
