#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e
set -o pipefail

# Function to print messages
print_message() {
  echo
  echo "================================================================"
  echo "$1"
  echo "================================================================"
  echo
}

# Step 1: Start Backend
print_message "Starting Backend with PM2..."
pm2 start npm --name=6529backend -- run backend

# Step 2: Start API
print_message "Starting API with PM2 on port 3000..."
pm2 start npm --name=6529api -- run api

print_message "Backend and API are now running!"