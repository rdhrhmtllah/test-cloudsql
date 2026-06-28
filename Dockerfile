# Use the official Node.js 20 lightweight Alpine image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package.json first to leverage Docker layer caching
COPY package.json ./

# Install production dependencies only
RUN npm install

# Copy the rest of the application files
COPY . .

# Expose port 8080 (Cloud Run default)
EXPOSE 8080

# Run the web server
CMD ["node", "server.js"]
