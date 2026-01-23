# Stage 1: Build the frontend and backend
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build
# The above builds the frontend to /app/dist

# Stage 2: Run the server
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
# Install only production dependencies
RUN npm install --production

# Install tsx globally to run server.ts directly
RUN npm install -g tsx

COPY --from=build /app/dist ./dist
COPY server.ts ./

EXPOSE 80

ENV PORT=80

CMD ["tsx", "server.ts"]
