#!/bin/bash

# Enclave Trading Bot - Deployment Script for Contabo VPS
# This script automates the deployment process

set -e  # Exit on any error

echo "🚀 Enclave Trading Bot - Deployment Script"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${RED}Error: .env file not found!${NC}"
    echo "Please create a .env file with your configuration."
    echo "You can copy .env.example as a template:"
    echo "  cp .env.example .env"
    exit 1
fi

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Docker is not installed!${NC}"
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    echo -e "${GREEN}Docker installed successfully!${NC}"
    echo "Please log out and log back in for group changes to take effect."
    exit 0
fi

# Check if Docker Compose is installed
if ! command -v docker compose &> /dev/null; then
    echo -e "${RED}Docker Compose is not installed!${NC}"
    echo "Installing Docker Compose..."
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
    echo -e "${GREEN}Docker Compose installed successfully!${NC}"
fi

echo -e "${YELLOW}Stopping existing container (if any)...${NC}"
docker compose down || true

echo -e "${YELLOW}Building Docker image...${NC}"
docker compose build --no-cache

echo -e "${YELLOW}Starting bot container...${NC}"
docker compose up -d

echo ""
echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo "Bot status:"
docker compose ps

echo ""
echo "To view logs:"
echo "  docker compose logs -f enclave-bot"
echo ""
echo "To stop the bot:"
echo "  docker compose down"
echo ""
echo "To restart the bot:"
echo "  docker compose restart"
echo ""
