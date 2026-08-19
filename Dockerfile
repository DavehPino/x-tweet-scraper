# x-tweet-scraper — Apify Actor image
# Node 22 per the assessment constraints.
FROM apify/actor-node:22

# Install all deps (dev deps needed for the build step).
COPY package.json package-lock.json ./
RUN npm ci --silent --include=dev

# Copy source and build TypeScript.
COPY . ./
RUN npm run build

# Remove dev dependencies before runtime.
RUN npm prune --omit=dev --silent

CMD ["npm", "run", "start"]