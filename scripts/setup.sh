#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e
set -o pipefail

# Define variables
REPO_URL="https://github.com/6529-Collections/6529seize-backend.git"
BRANCH="seize-lite"

# Function to print messages
print_message() {
  echo
  echo "================================================================"
  echo "$1"
  echo "================================================================"
  echo
}

# Step 1: Clone the repository
print_message "Cloning the repository..."
git clone --branch $BRANCH $REPO_URL

# Step 2: Install NPM
print_message "Installing npm..."
sudo apt update
sudo apt install -y npm

# Step 3: Install n and switch to npm version 21
print_message "Installing 'n' and setting npm version to 21..."
sudo npm install -g n
sudo n 21

# Reset session
hash -r

# Step 4: Navigate to the cloned repository
REPO_DIR=$(basename $REPO_URL .git)
cd $REPO_DIR

# Step 5: Install dependencies
print_message "Installing dependencies..."
npm install

# Step 6: Build the project
print_message "Building the project..."
npm run build

# Step 7: Install PM2
print_message "Installing PM2..."
sudo npm install -g pm2@latest

# Step 8: Configure PM2 to auto-restart on system reboot
print_message "Configuring PM2 to auto-restart on system reboot..."
pm2 startup

# Step 9: Set up PM2 log rotation
print_message "Setting up PM2 log rotation..."
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 10
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD
pm2 set pm2-logrotate:rotateModule true

print_message "All steps completed successfully!"
