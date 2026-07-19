FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm install --production

# Bundle app source
COPY . .

# Expose port (Render defaults to looking for an exposed port, or using process.env.PORT)
EXPOSE 3000

# Start the application
CMD [ "node", "server.js" ]
