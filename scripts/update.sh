#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e
set -o pipefail

# Define variables
BRANCH="seize-lite"
REPO_DIR="6529seize-backend"

# Function to print messages
print_message() {
  echo
  echo "================================================================"
  echo "$1"
  echo "================================================================"
  echo
}

# Step 1: Navigate to the repository directory
print_message "Navigating to the repository directory..."
cd $REPO_DIR

# Step 2: Pull the latest changes from the specified branch
print_message "Pulling the latest changes from the branch $BRANCH..."
git fetch origin
git checkout $BRANCH
git pull origin $BRANCH

# Step 3: Reinstall dependencies
print_message "Reinstalling dependencies..."
npm install

# Step 4: Rebuild the project
print_message "Rebuilding the project..."
npm run build

# Step 5: Restart PM2 services
print_message "Restarting PM2 services..."
pm2 restart 6529backend
pm2 restart 6529api

print_message "Update completed successfully!"
