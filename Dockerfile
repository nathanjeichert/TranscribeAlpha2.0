# Multi-stage build: Node.js for frontend, Python for backend
FROM node:18-alpine AS frontend-builder

# Build the Next.js frontend
WORKDIR /app/frontend-next
COPY frontend-next/package.json frontend-next/package-lock.json* ./
RUN npm install
COPY frontend-next/ .
RUN npm run build

# Python backend stage
FROM python:3.11-slim AS backend

# App variant: "oncue" (default) or "criminal"
ARG APP_VARIANT=oncue
ENV APP_VARIANT=${APP_VARIANT}

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . .

# Copy the built frontend from the frontend-builder stage
COPY --from=frontend-builder /app/frontend-next/out ./frontend

# Expose the port that Cloud Run expects
EXPOSE 8080

# Set environment variables for Cloud Run
ENV PORT=8080
ENV HOST=0.0.0.0

# Run the application
CMD ["python", "main.py"]
