#!/bin/sh
echo "Running database migrations..."
npx drizzle-kit push --force
echo "Starting application..."
npm run start
