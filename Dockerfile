# Imagen de Gestor DeCA y eCMR.
# Para que las actualizaciones automáticas funcionen y se conserven, monta la carpeta de la aplicación
# en /app (ver docker-compose.example.yml): así el supervisor puede sustituir el código y los cambios
# sobreviven a la recreación del contenedor. Sin ese montaje, la imagen funciona con el código incluido.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "scripts/supervisor.js"]
