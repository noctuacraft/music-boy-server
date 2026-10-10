FROM node:20-slim

# Instalar Python, pip y ffmpeg (ffmpeg es vital para yt-dlp)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Instalar/Actualizar yt-dlp usando la bandera correcta para evitar errores de entornos de Python
RUN pip3 install --no-cache-dir -U yt-dlp --break-system-packages || pip3 install --no-cache-dir -U yt-dlp

# Crear directorio de la app
WORKDIR /app

# Copiar package.json e instalar dependencias de Node
COPY package*.json ./
RUN npm install

# Copiar el resto del código del servidor
COPY . .

# Exponer el puerto
EXPOSE 3456

# Iniciar servidor
CMD ["npm", "start"]
